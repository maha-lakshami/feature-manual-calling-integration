import { NextRequest, NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";

type TranscriptEntry = {
  id: string;
  speaker: "customer" | "salesperson";
  text: string;
  timestamp: string;
};

type TranscriptFile = {
  callId: string;
  entries: TranscriptEntry[];
};

const TRANSCRIPT_DIR = path.join(
  process.cwd(),
  "transcripts"
);

async function ensureTranscriptDirectory() {
  await fs.mkdir(TRANSCRIPT_DIR, {
    recursive: true,
  });
}

function getTranscriptFilePath(callId: string) {
  const safeCallId = callId.replace(
    /[^a-zA-Z0-9_-]/g,
    "_"
  );

  return path.join(
    TRANSCRIPT_DIR,
    `${safeCallId}.json`
  );
}

/*
 * GET
 *
 * Returns the actual transcript recorded for a call.
 */
export async function GET(
  request: NextRequest,
  context: {
    params: Promise<{
      id: string;
    }>;
  }
) {
  try {
    const { id: callId } = await context.params;

    if (!callId) {
      return NextResponse.json(
        {
          success: false,
          error: "Call ID is required",
        },
        { status: 400 }
      );
    }

    await ensureTranscriptDirectory();

    const filePath =
      getTranscriptFilePath(callId);

    try {
      const fileContent =
        await fs.readFile(
          filePath,
          "utf-8"
        );

      const transcript: TranscriptFile =
        JSON.parse(fileContent);

      const formattedTranscript =
        transcript.entries
          .map((entry) => {
            const speaker =
              entry.speaker === "customer"
                ? "Customer"
                : "Salesperson";

            return `${speaker}: ${entry.text}`;
          })
          .join("\n");

      return NextResponse.json({
        success: true,
        callId,
        transcript:
          formattedTranscript,
        entries:
          transcript.entries,
      });
    } catch (error) {
      /*
       * No transcript file yet.
       *
       * This is normal when the call has just started.
       */
      return NextResponse.json({
        success: true,
        callId,
        transcript: "",
        entries: [],
      });
    }
  } catch (error) {
    console.error(
      "Transcript GET error:",
      error
    );

    return NextResponse.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to load transcript",
      },
      { status: 500 }
    );
  }
}

/*
 * POST
 *
 * Adds one REAL finalized speech segment
 * to the transcript.
 *
 * This endpoint is called by voice-server.mjs
 * after Gemini transcribes the actual Plivo audio.
 */
export async function POST(
  request: NextRequest,
  context: {
    params: Promise<{
      id: string;
    }>;
  }
) {
  try {
    const { id: callId } = await context.params;

    if (!callId) {
      return NextResponse.json(
        {
          success: false,
          error: "Call ID is required",
        },
        { status: 400 }
      );
    }

    const body = await request.json();

    const speaker = body.speaker;
    const text = body.text;
    const timestamp =
      body.timestamp ||
      new Date().toISOString();

    if (
      speaker !== "customer" &&
      speaker !== "salesperson"
    ) {
      return NextResponse.json(
        {
          success: false,
          error:
            "speaker must be customer or salesperson",
        },
        { status: 400 }
      );
    }

    if (
      typeof text !== "string" ||
      !text.trim()
    ) {
      return NextResponse.json(
        {
          success: false,
          error: "Transcript text is required",
        },
        { status: 400 }
      );
    }

    await ensureTranscriptDirectory();

    const filePath =
      getTranscriptFilePath(callId);

    let transcript: TranscriptFile = {
      callId,
      entries: [],
    };

    try {
      const existingFile =
        await fs.readFile(
          filePath,
          "utf-8"
        );

      transcript = JSON.parse(
        existingFile
      );
    } catch {
      /*
       * Transcript file does not exist yet.
       * Create a new one.
       */
    }

    const entry: TranscriptEntry = {
      id: `${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 10)}`,
      speaker,
      text: text.trim(),
      timestamp,
    };

    transcript.entries.push(entry);

    await fs.writeFile(
      filePath,
      JSON.stringify(
        transcript,
        null,
        2
      ),
      "utf-8"
    );

    console.log(
      `[TRANSCRIPT] ${
        speaker === "customer"
          ? "Customer"
          : "Salesperson"
      }: ${text.trim()}`
    );

    return NextResponse.json({
      success: true,
      entry,
      transcript:
        transcript.entries
          .map((item) => {
            const speakerName =
              item.speaker ===
              "customer"
                ? "Customer"
                : "Salesperson";

            return `${speakerName}: ${item.text}`;
          })
          .join("\n"),
    });
  } catch (error) {
    console.error(
      "Transcript POST error:",
      error
    );

    return NextResponse.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to save transcript",
      },
      { status: 500 }
    );
  }
}