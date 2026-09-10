import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();

    const requestUUID = formData.get("RequestUUID")?.toString();
    const callUUID = formData.get("CallUUID")?.toString();
    const callStatus = formData.get("CallStatus")?.toString();

    console.log("=================================");
    console.log("Plivo Status Webhook");
    console.log("RequestUUID:", requestUUID);
    console.log("CallUUID:", callUUID);
    console.log("CallStatus:", callStatus);
    console.log("=================================");

    if (!requestUUID && !callUUID) {
      return NextResponse.json(
        {
          success: false,
          message: "Missing RequestUUID or CallUUID",
        },
        { status: 400 }
      );
    }

    /*
     * Find the CRM call using the Plivo request/call ID.
     */
    const call = await prisma.call.findFirst({
      where: {
        OR: [
          ...(requestUUID
            ? [{ providerCallId: requestUUID }]
            : []),
          ...(callUUID
            ? [{ providerCallId: callUUID }]
            : []),
        ],
      },
    });

    if (!call) {
      console.log("⚠️ Call record not found");

      return NextResponse.json({
        success: true,
        message: "Call record not found",
      });
    }

    const newStatus = callStatus?.toUpperCase();

    console.log("CRM Call ID:", call.id);
    console.log("New status:", newStatus);

    /*
     * IMPORTANT
     *
     * Start the audio stream only when Plivo tells us
     * that the call is active.
     *
     * We DO NOT start the stream from answer/route.ts anymore.
     *
     * This prevents the stream from interfering with
     * the normal <Dial> call flow.
     */
    const activeStatuses = [
      "IN-PROGRESS",
      "IN_PROGRESS",
      "ANSWERED",
      "CONNECTED",
    ];

    if (
      newStatus &&
      activeStatuses.includes(newStatus) &&
      callUUID
    ) {
      console.log(
        "🎙️ Active call detected. Starting audio stream..."
      );

      /*
       * Do not wait for the stream API response before
       * returning the status webhook response.
       *
       * The phone call should continue normally.
       */
      void startPlivoAudioStream(callUUID);
    }

    /*
     * Calculate duration when the call has ended.
     */
    let durationSeconds = call.durationSeconds;
    let endedAt = call.endedAt;

    const completedStatuses = [
      "COMPLETED",
      "FAILED",
      "BUSY",
      "NO_ANSWER",
      "CANCELED",
      "CANCELLED",
    ];

    if (
      newStatus &&
      completedStatuses.includes(newStatus)
    ) {
      endedAt = new Date();

      if (call.startedAt) {
        durationSeconds = Math.max(
          0,
          Math.floor(
            (endedAt.getTime() -
              call.startedAt.getTime()) /
              1000
          )
        );
      }
    }

    /*
     * Only update the database if the status is one
     * of the statuses supported by the Prisma enum.
     */
    const supportedStatuses = [
      "INITIATING",
      "RINGING",
      "CONNECTED",
      "COMPLETED",
      "FAILED",
      "BUSY",
      "NO_ANSWER",
    ] as const;

    const prismaStatus =
      newStatus &&
      supportedStatuses.includes(
        newStatus as (typeof supportedStatuses)[number]
      )
        ? (newStatus as (typeof supportedStatuses)[number])
        : call.status;

    const updatedCall = await prisma.call.update({
      where: {
        id: call.id,
      },
      data: {
        status: prismaStatus,
        endedAt,
        durationSeconds,
      },
    });

    console.log("✅ Call updated successfully");
    console.log("Call ID:", updatedCall.id);
    console.log("Status:", updatedCall.status);
    console.log(
      "Duration:",
      updatedCall.durationSeconds
    );

    return NextResponse.json({
      success: true,
      message: "Call status updated successfully",
      call: {
        id: updatedCall.id,
        status: updatedCall.status,
        durationSeconds:
          updatedCall.durationSeconds,
        endedAt: updatedCall.endedAt,
      },
    });
  } catch (error) {
    console.error(
      "❌ Status webhook error:",
      error
    );

    return NextResponse.json(
      {
        success: false,
        message: "Failed to update call status",
      },
      { status: 500 }
    );
  }
}

/*
 * Start Plivo Audio Stream on the active call.
 */
async function startPlivoAudioStream(
  callUUID: string
) {
  try {
    const authId =
      process.env.PLIVO_AUTH_ID;

    const authToken =
      process.env.PLIVO_AUTH_TOKEN;

    const websocketUrl =
      process.env.PLIVO_STREAM_WS_URL ||
      "wss://herbal-scanning-disjoin.ngrok-free.dev";

    if (!authId || !authToken) {
      console.error(
        "❌ PLIVO_AUTH_ID or PLIVO_AUTH_TOKEN is missing from .env"
      );
      return;
    }

    console.log("=================================");
    console.log(
      "🎙️ Starting Plivo Audio Stream"
    );
    console.log("CallUUID:", callUUID);
    console.log(
      "WebSocket:",
      websocketUrl
    );
    console.log("Audio track: both");
    console.log(
      "Bidirectional: false"
    );
    console.log("=================================");

    const streamUrl =
      `https://api.plivo.com/v1/Account/${encodeURIComponent(
        authId
      )}/Call/${encodeURIComponent(
        callUUID
      )}/Stream/`;

    const credentials =
      Buffer.from(
        `${authId}:${authToken}`
      ).toString("base64");

    const response = await fetch(
      streamUrl,
      {
        method: "POST",

        headers: {
          Authorization:
            `Basic ${credentials}`,

          "Content-Type":
            "application/json",
        },

        body: JSON.stringify({
          service_url: websocketUrl,

          bidirectional: false,

          audio_track: "both",

          stream_timeout: 3600,

          content_type:
            "audio/x-mulaw;rate=8000",
        }),
      }
    );

    const responseText =
      await response.text();

    if (!response.ok) {
      console.error(
        "❌ Plivo Audio Stream failed"
      );

      console.error(
        "HTTP status:",
        response.status
      );

      console.error(
        "Plivo response:",
        responseText
      );

      return;
    }

    let responseData: unknown =
      responseText;

    try {
      responseData =
        JSON.parse(responseText);
    } catch {
      // Keep the raw response.
    }

    console.log(
      "✅ Plivo Audio Stream started!"
    );

    console.log(
      "Stream response:",
      responseData
    );
  } catch (error) {
    console.error(
      "❌ Error starting Plivo Audio Stream:",
      error
    );
  }
}