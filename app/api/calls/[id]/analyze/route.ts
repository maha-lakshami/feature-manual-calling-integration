import {
  GoogleGenAI,
  ThinkingLevel,
} from "@google/genai";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

if (!GEMINI_API_KEY) {
  throw new Error("Missing GEMINI_API_KEY in .env");
}

const ai = new GoogleGenAI({
  apiKey: GEMINI_API_KEY,
});

/*
 * Gemini models.
 *
 * Primary:
 *   gemini-3.7-flash
 *
 * Fallbacks:
 *   gemini-3.6-flash
 *   gemini-3.5-flash-lite
 */
const MODELS = [
  "gemini-3.7-flash",
  "gemini-3.6-flash",
  "gemini-3.5-flash-lite",
] as const;

type GeminiModel = (typeof MODELS)[number];

const OUTCOMES = [
  "INTERESTED",
  "FOLLOW_UP_REQUIRED",
  "CALL_BACK_REQUESTED",
  "NOT_INTERESTED",
  "PRICE_OBJECTION",
  "NEEDS_DISCUSSION",
  "DECISION_PENDING",
  "MEETING_REQUIRED",
  "DEMO_REQUIRED",
  "CONVERTED",
  "NO_RESPONSE",
  "WRONG_NUMBER",
  "LOST",
  "OTHER",
] as const;

const INTEREST_LEVELS = [
  "HIGH",
  "MEDIUM",
  "LOW",
  "UNKNOWN",
] as const;

const NEXT_ACTIONS = [
  "FOLLOW_UP",
  "CALL_BACK",
  "SEND_QUOTATION",
  "SEND_INFORMATION",
  "SCHEDULE_MEETING",
  "SCHEDULE_DEMO",
  "WAIT_FOR_CUSTOMER",
  "MOVE_TO_ONBOARDING",
  "NO_ACTION",
  "RETRY_CALL",
] as const;

const PRIORITIES = [
  "HIGH",
  "MEDIUM",
  "LOW",
] as const;

type GeminiOutcome = (typeof OUTCOMES)[number];
type GeminiInterest = (typeof INTEREST_LEVELS)[number];
type GeminiNextAction = (typeof NEXT_ACTIONS)[number];
type GeminiPriority = (typeof PRIORITIES)[number];

const responseSchema = {
  type: "object",
  properties: {
    summary: {
      type: "string",
      description:
        "A concise summary of the customer conversation.",
    },

    outcome: {
      type: "string",
      enum: [...OUTCOMES],
    },

    interest: {
      type: "string",
      enum: [...INTEREST_LEVELS],
    },

    requirement: {
      type: "string",
      description:
        "The customer's main requirement or need. Use an empty string if not mentioned.",
    },

    objection: {
      type: "string",
      description:
        "The customer's main objection or concern. Use an empty string if there is no objection.",
    },

    nextAction: {
      type: "string",
      enum: [...NEXT_ACTIONS],
    },

    followUpRequired: {
      type: "boolean",
    },

    followUpDate: {
      type: "string",
      description:
        "Follow-up date in exact YYYY-MM-DD format. Return an empty string if no follow-up date exists.",
    },

    followUpTime: {
      type: "string",
      description:
        "Follow-up time in exact HH:MM 24-hour format. Return an empty string if no time is mentioned.",
    },

    priority: {
      type: "string",
      enum: [...PRIORITIES],
    },

    reason: {
      type: "string",
      description:
        "Brief explanation for the selected outcome, interest level, next action, priority, and follow-up decision.",
    },

    confidence: {
      type: "number",
      minimum: 0,
      maximum: 1,
    },
  },

  required: [
    "summary",
    "outcome",
    "interest",
    "requirement",
    "objection",
    "nextAction",
    "followUpRequired",
    "followUpDate",
    "followUpTime",
    "priority",
    "reason",
    "confidence",
  ],
};

type GeminiAnalysis = {
  summary: string;
  outcome: GeminiOutcome;
  interest: GeminiInterest;
  requirement: string;
  objection: string;
  nextAction: GeminiNextAction;
  followUpRequired: boolean;
  followUpDate: string;
  followUpTime: string;
  priority: GeminiPriority;
  reason: string;
  confidence: number;
};

/*
 * Check whether an error is temporary and worth retrying.
 *
 * IMPORTANT:
 * The Gemini SDK throws AbortError when our HTTP timeout
 * is reached. We must treat that as a temporary error.
 */
function isTemporaryGeminiError(error: unknown): boolean {
  const err = error as {
    name?: string;
    status?: number;
    code?: number | string;
    message?: string;
    cause?: {
      name?: string;
      code?: string;
      message?: string;
    };
  };

  const status = err?.status ?? err?.code;

  const message =
    typeof err?.message === "string"
      ? err.message.toLowerCase()
      : "";

  const causeMessage =
    typeof err?.cause?.message === "string"
      ? err.cause.message.toLowerCase()
      : "";

  const causeCode =
    typeof err?.cause?.code === "string"
      ? err.cause.code.toLowerCase()
      : "";

  const errorName =
    typeof err?.name === "string"
      ? err.name.toLowerCase()
      : "";

  const causeName =
    typeof err?.cause?.name === "string"
      ? err.cause.name.toLowerCase()
      : "";

  return (
    status === 429 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504 ||

    message.includes("high demand") ||
    message.includes("unavailable") ||
    message.includes("temporarily") ||
    message.includes("rate limit") ||
    message.includes("timeout") ||
    message.includes("timed out") ||
    message.includes("fetch failed") ||
    message.includes("aborted") ||

    causeMessage.includes("timeout") ||
    causeMessage.includes("timed out") ||
    causeMessage.includes("fetch failed") ||
    causeMessage.includes("aborted") ||

    causeCode.includes("timeout") ||
    causeCode.includes("und_err") ||

    errorName === "aborterror" ||
    errorName.includes("abort") ||

    causeName === "aborterror" ||
    causeName.includes("abort")
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/*
 * Validate an exact YYYY-MM-DD date.
 */
function isValidDateString(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }

  const [year, month, day] = value
    .split("-")
    .map(Number);

  const date = new Date(
    Date.UTC(year, month - 1, day)
  );

  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

/*
 * Validate an exact HH:MM 24-hour time.
 */
function isValidTimeString(value: string): boolean {
  return /^([01]\d|2[0-3]):([0-5]\d)$/.test(value);
}

/*
 * Validate Gemini enum values.
 */
function isValidEnumValue<T extends readonly string[]>(
  value: unknown,
  allowed: T
): value is T[number] {
  return (
    typeof value === "string" &&
    allowed.includes(value)
  );
}

/*
 * Call Gemini with timeout and automatic model fallback.
 */
async function generateGeminiAnalysis(
  prompt: string
): Promise<{
  responseText: string;
  model: GeminiModel;
}> {
  let lastError: unknown = null;

  for (const model of MODELS) {
    console.log("=================================");
    console.log("Trying Gemini model:", model);
    console.log("=================================");

    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        console.log(
          `Gemini attempt ${attempt}/2 using ${model}`
        );

        const response =
          await ai.models.generateContent({
            model,
            contents: prompt,

            config: {
              responseMimeType: "application/json",

              responseSchema,

              /*
               * CRM classification does not need
               * heavy reasoning.
               *
               * LOW reduces latency.
               */
              thinkingConfig: {
                thinkingLevel: ThinkingLevel.LOW,
              },

              /*
               * Stop the request from hanging for
               * several minutes.
               *
               * Timeout is milliseconds.
               */
              httpOptions: {
                timeout: 45_000,
              },

              /*
               * Small structured response.
               */
              maxOutputTokens: 1000,
            },
          });

        const responseText =
          response.text?.trim();

        if (!responseText) {
          throw new Error(
            `Gemini returned an empty response from ${model}`
          );
        }

        console.log(
          "Gemini response received successfully."
        );

        console.log(
          "Model used:",
          model
        );

        return {
          responseText,
          model,
        };
      } catch (error) {
        lastError = error;

        console.error(
          `Gemini error using ${model}, attempt ${attempt}:`,
          error
        );

        const temporary =
          isTemporaryGeminiError(error);

        /*
         * Retry temporary errors once.
         */
        if (
          temporary &&
          attempt < 2
        ) {
          console.log(
            `Temporary Gemini error. Retrying ${model}...`
          );

          await sleep(1500);

          continue;
        }

        /*
         * If this model failed after retry,
         * move to the next fallback model.
         */
        if (temporary) {
          console.log(
            `Model ${model} unavailable. Moving to fallback model.`
          );

          break;
        }

        /*
         * Non-temporary errors should stop immediately.
         */
        throw error;
      }
    }
  }

  throw (
    lastError instanceof Error
      ? lastError
      : new Error(
          "All Gemini models are currently unavailable."
        )
  );
}

export async function POST(
  request: NextRequest,
  context: {
    params: Promise<{ id: string }>;
  }
) {
  try {
    void request;

    const { id } =
      await context.params;

    console.log("=================================");
    console.log("Gemini Call Analysis");
    console.log("Call ID:", id);
    console.log("=================================");

    /*
     * 1. FIND CALL
     */
    const call =
      await prisma.call.findUnique({
        where: {
          id,
        },
      });

    if (!call) {
      return NextResponse.json(
        {
          success: false,
          message: "Call not found",
        },
        {
          status: 404,
        }
      );
    }

    /*
     * 2. CHECK MANUAL NOTES
     */
    if (!call.manualNotes?.trim()) {
      return NextResponse.json(
        {
          success: false,
          message:
            "Please add manual call notes before running AI analysis.",
        },
        {
          status: 400,
        }
      );
    }

    /*
     * 3. CREATE GEMINI PROMPT
     */
    const today =
      new Date();

    const todayString =
      today
        .toISOString()
        .split("T")[0];

    const prompt = `
You are an expert CRM sales-call analyst.

Analyze the following salesperson notes from a customer phone call.

Your job is to classify the conversation accurately for a CRM.

IMPORTANT RULES:

- Do not invent information that is not present.
- Keep the summary concise.
- Identify the customer's actual requirement if one exists.
- Identify an objection only if the customer expressed a concern or resistance.
- Determine the customer's interest level.
- Determine the most appropriate outcome.
- Determine the most appropriate next action.
- Set followUpRequired to true only when a follow-up is actually needed.
- Set priority based on the customer's demonstrated interest and urgency.
- Confidence must be between 0 and 1.
- If information is missing, use UNKNOWN, OTHER, or NO_ACTION where appropriate.

FOLLOW-UP DATE RULES:

- If the customer requests a follow-up, set followUpRequired to true.
- If the customer says "call me Friday", "call back Friday", or similar, calculate the actual upcoming Friday date.
- Today's date is ${todayString}.
- If the customer says "tomorrow", calculate the actual date.
- If the customer says "next week", determine the appropriate date only when the notes clearly specify the intended day.
- Return followUpDate in EXACT YYYY-MM-DD format.
- Do not return a date with a time.
- Do not return a natural-language date.
- Do not invent a date when there is no follow-up request.
- If there is no follow-up date, return an empty string.
- If followUpRequired is false, return an empty string for followUpDate.

FOLLOW-UP TIME RULES:

- Only provide followUpTime when the customer explicitly mentions a time.
- Use EXACT HH:MM 24-hour format.
- If no time is mentioned, return an empty string.
- Never invent a time.
- If followUpRequired is false, return an empty string for followUpTime.

SALESPERSON NOTES:

${call.manualNotes}
`;

    /*
     * 4. ASK GEMINI WITH FALLBACK
     */
    const {
      responseText,
      model,
    } =
      await generateGeminiAnalysis(
        prompt
      );

    console.log("=================================");
    console.log("Gemini raw response:");
    console.log(responseText);
    console.log("Model:", model);
    console.log("=================================");

    /*
     * 5. PARSE RESPONSE
     */
    let analysis: GeminiAnalysis;

    try {
      analysis =
        JSON.parse(
          responseText
        ) as GeminiAnalysis;
    } catch {
      throw new Error(
        "Gemini returned invalid JSON."
      );
    }

    /*
     * 6. BASIC VALIDATION
     */
    if (!analysis.summary?.trim()) {
      throw new Error(
        "Gemini response is missing summary."
      );
    }

    if (
      !isValidEnumValue(
        analysis.outcome,
        OUTCOMES
      )
    ) {
      throw new Error(
        `Invalid outcome returned by Gemini: ${analysis.outcome}`
      );
    }

    if (
      !isValidEnumValue(
        analysis.interest,
        INTEREST_LEVELS
      )
    ) {
      throw new Error(
        `Invalid interest returned by Gemini: ${analysis.interest}`
      );
    }

    if (
      !isValidEnumValue(
        analysis.nextAction,
        NEXT_ACTIONS
      )
    ) {
      throw new Error(
        `Invalid next action returned by Gemini: ${analysis.nextAction}`
      );
    }

    if (
      !isValidEnumValue(
        analysis.priority,
        PRIORITIES
      )
    ) {
      throw new Error(
        `Invalid priority returned by Gemini: ${analysis.priority}`
      );
    }

    if (
      typeof analysis.followUpRequired !==
      "boolean"
    ) {
      throw new Error(
        "Gemini returned an invalid follow-up flag."
      );
    }

    /*
     * 7. NORMALIZE FOLLOW-UP DATE/TIME
     */
    let followUpDate:
      | string
      | null = null;

    let followUpTime:
      | string
      | null = null;

    if (analysis.followUpRequired) {
      /*
       * DATE
       */
      const rawDate =
        typeof analysis.followUpDate ===
        "string"
          ? analysis.followUpDate.trim()
          : "";

      if (rawDate) {
        if (!isValidDateString(rawDate)) {
          throw new Error(
            `Gemini returned an invalid follow-up date: ${rawDate}. Expected YYYY-MM-DD.`
          );
        }

        followUpDate = rawDate;
      }

      /*
       * TIME
       */
      const rawTime =
        typeof analysis.followUpTime ===
        "string"
          ? analysis.followUpTime.trim()
          : "";

      if (rawTime) {
        if (!isValidTimeString(rawTime)) {
          throw new Error(
            `Gemini returned an invalid follow-up time: ${rawTime}. Expected HH:MM.`
          );
        }

        followUpTime = rawTime;
      }
    }

    /*
     * No follow-up means no date/time.
     */
    if (
      !analysis.followUpRequired
    ) {
      followUpDate = null;
      followUpTime = null;
    }

    /*
     * Confidence validation.
     */
    const confidenceNumber =
      Number(
        analysis.confidence
      );

    if (
      !Number.isFinite(
        confidenceNumber
      ) ||
      confidenceNumber < 0 ||
      confidenceNumber > 1
    ) {
      throw new Error(
        "Gemini returned an invalid confidence value."
      );
    }

    const confidence =
      Math.min(
        1,
        Math.max(
          0,
          confidenceNumber
        )
      );

    console.log(
      "================================="
    );

    console.log(
      "Normalized Follow-up Date:",
      followUpDate
    );

    console.log(
      "Normalized Follow-up Time:",
      followUpTime
    );

    console.log(
      "================================="
    );

    /*
     * 8. SAVE ANALYSIS
     */
    const savedAnalysis =
      await prisma.callAIAnalysis.upsert({
        where: {
          callId: call.id,
        },

        update: {
          summary:
            analysis.summary.trim(),

          outcome:
            analysis.outcome,

          interest:
            analysis.interest,

          requirement:
            analysis.requirement
              ?.trim()
              ? analysis.requirement.trim()
              : null,

          objection:
            analysis.objection
              ?.trim()
              ? analysis.objection.trim()
              : null,

          nextAction:
            analysis.nextAction,

          followUpRequired:
            Boolean(
              analysis.followUpRequired
            ),

          followUpDate:
            followUpDate
              ? new Date(
                  `${followUpDate}T00:00:00`
                )
              : null,

          followUpTime,

          priority:
            analysis.priority,

          reason:
            analysis.reason?.trim() ||
            "Gemini analysis completed.",

          confidence,

          model,

          /*
           * New Gemini analysis needs
           * human review again.
           */
          humanReviewed: false,

          reviewedAt: null,

          reviewedBy: null,
        },

        create: {
          callId: call.id,

          summary:
            analysis.summary.trim(),

          outcome:
            analysis.outcome,

          interest:
            analysis.interest,

          requirement:
            analysis.requirement
              ?.trim()
              ? analysis.requirement.trim()
              : null,

          objection:
            analysis.objection
              ?.trim()
              ? analysis.objection.trim()
              : null,

          nextAction:
            analysis.nextAction,

          followUpRequired:
            Boolean(
              analysis.followUpRequired
            ),

          followUpDate:
            followUpDate
              ? new Date(
                  `${followUpDate}T00:00:00`
                )
              : null,

          followUpTime,

          priority:
            analysis.priority,

          reason:
            analysis.reason?.trim() ||
            "Gemini analysis completed.",

          confidence,

          model,

          humanReviewed: false,

          reviewedAt: null,

          reviewedBy: null,
        },
      });

    /*
     * 9. LOG RESULT
     */
    console.log(
      "================================="
    );

    console.log(
      "AI analysis saved successfully"
    );

    console.log(
      "Model used:",
      model
    );

    console.log(
      "Call ID:",
      call.id
    );

    console.log(
      "Outcome:",
      savedAnalysis.outcome
    );

    console.log(
      "Interest:",
      savedAnalysis.interest
    );

    console.log(
      "Next Action:",
      savedAnalysis.nextAction
    );

    console.log(
      "Follow-up Required:",
      savedAnalysis.followUpRequired
    );

    console.log(
      "Follow-up Date:",
      savedAnalysis.followUpDate
    );

    console.log(
      "Follow-up Time:",
      savedAnalysis.followUpTime
    );

    console.log(
      "Priority:",
      savedAnalysis.priority
    );

    console.log(
      "Confidence:",
      savedAnalysis.confidence
    );

    console.log(
      "================================="
    );

    /*
     * 10. RETURN RESPONSE
     */
    return NextResponse.json({
      success: true,

      message:
        "Call analyzed successfully",

      analysis:
        savedAnalysis,

      model,
    });
  } catch (error) {
    console.error(
      "Gemini call analysis error:",
      error
    );

    const isTemporary =
      isTemporaryGeminiError(
        error
      );

    return NextResponse.json(
      {
        success: false,

        message: isTemporary
          ? "Gemini is temporarily unavailable. Please try the analysis again."
          : error instanceof Error
            ? error.message
            : "Failed to analyze call",
      },
      {
        status: isTemporary
          ? 503
          : 500,
      }
    );
  }
}