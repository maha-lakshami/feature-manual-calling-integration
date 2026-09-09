import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();

    const callUUID = formData.get("CallUUID")?.toString();
    const requestUUID = formData.get("RequestUUID")?.toString();

    const { searchParams } = new URL(request.url);

    const customerId = searchParams.get("customerId");
    const customerPhone = searchParams.get("customerPhone");

    console.log("=================================");
    console.log("📞 Plivo Answer Webhook");
    console.log("CallUUID:", callUUID);
    console.log("RequestUUID:", requestUUID);
    console.log("Customer ID:", customerId);
    console.log("Customer Phone:", customerPhone);
    console.log("=================================");

    if (!customerPhone) {
      return new NextResponse(
        `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Speak>Sorry, the customer number is missing.</Speak>
  <Hangup/>
</Response>`,
        {
          status: 200,
          headers: {
            "Content-Type": "application/xml",
          },
        }
      );
    }

    /*
     * Update CRM call status.
     */
    if (customerId) {
      await prisma.call.updateMany({
        where: {
          customerId,
          status: {
            in: ["INITIATING", "RINGING"],
          },
        },
        data: {
          status: "CONNECTED",
        },
      });
    }

    /*
     * IMPORTANT:
     *
     * Start Plivo Audio Stream immediately.
     *
     * We already have the CallUUID here.
     * Do not wait for the status webhook.
     */
    if (callUUID) {
      void startPlivoAudioStream(callUUID);
    } else {
      console.warn(
        "⚠️ No CallUUID received. Audio stream cannot be started."
      );
    }

    /*
     * Connect the salesperson/customer call.
     */
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial
    callerId="${escapeXml(process.env.PLIVO_PHONE_NUMBER || "")}"
    timeout="30"
    hangupOnStar="false"
  >
    <Number>${escapeXml(customerPhone)}</Number>
  </Dial>
</Response>`;

    console.log(
      "📞 Connecting salesperson to customer:",
      customerPhone
    );

    console.log(
      "🎙️ Audio stream start requested for CallUUID:",
      callUUID
    );

    return new NextResponse(xml, {
      status: 200,
      headers: {
        "Content-Type": "application/xml",
      },
    });
  } catch (error) {
    console.error("❌ Plivo answer webhook error:", error);

    return new NextResponse(
      `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Speak>Sorry, there was a technical problem.</Speak>
  <Hangup/>
</Response>`,
      {
        status: 500,
        headers: {
          "Content-Type": "application/xml",
        },
      }
    );
  }
}

/*
 * Start Plivo real-time audio streaming.
 */
async function startPlivoAudioStream(callUUID: string) {
  try {
    const authId = process.env.PLIVO_AUTH_ID;
    const authToken = process.env.PLIVO_AUTH_TOKEN;

    const websocketUrl =
      process.env.PLIVO_STREAM_WS_URL ||
      "wss://herbal-scanning-disjoin.ngrok-free.dev";

    if (!authId || !authToken) {
      console.error(
        "❌ Missing PLIVO_AUTH_ID or PLIVO_AUTH_TOKEN"
      );
      return;
    }

    if (!websocketUrl) {
      console.error(
        "❌ Missing PLIVO_STREAM_WS_URL"
      );
      return;
    }

    const streamUrl =
      `https://api.plivo.com/v1/Account/` +
      `${encodeURIComponent(authId)}/Call/` +
      `${encodeURIComponent(callUUID)}/Stream/`;

    const credentials = Buffer.from(
      `${authId}:${authToken}`
    ).toString("base64");

    console.log("=================================");
    console.log("🎙️ Starting Plivo Audio Stream");
    console.log("CallUUID:", callUUID);
    console.log("WebSocket:", websocketUrl);
    console.log("=================================");

    const response = await fetch(streamUrl, {
      method: "POST",

      headers: {
        Authorization: `Basic ${credentials}`,
        "Content-Type": "application/json",
      },

      body: JSON.stringify({
        service_url: websocketUrl,
        bidirectional: false,
        audio_track: "both",
        stream_timeout: 3600,
        content_type: "audio/x-mulaw;rate=8000",
      }),
    });

    const responseText = await response.text();

    if (!response.ok) {
      console.error(
        "❌ Plivo Audio Stream failed"
      );

      console.error(
        "Status:",
        response.status
      );

      console.error(
        "Response:",
        responseText
      );

      return;
    }

    console.log(
      "✅ Plivo Audio Stream started successfully"
    );

    console.log(
      "Stream response:",
      responseText
    );
  } catch (error) {
    console.error(
      "❌ Error starting Plivo Audio Stream:",
      error
    );
  }
}

function escapeXml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}