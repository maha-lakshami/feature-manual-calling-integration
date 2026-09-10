import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";

export async function POST(request: NextRequest) {
  try {
    // Razorpay webhook signature must be calculated
    // from the raw request body.
    const rawBody = await request.text();

    const receivedSignature =
      request.headers.get("x-razorpay-signature");

    const webhookSecret =
      process.env.RAZORPAY_WEBHOOK_SECRET;

    if (!webhookSecret) {
      console.error(
        "RAZORPAY_WEBHOOK_SECRET is not configured"
      );

      return NextResponse.json(
        {
          success: false,
          message: "Webhook secret is not configured",
        },
        { status: 500 }
      );
    }

    if (!receivedSignature) {
      console.error(
        "Missing Razorpay webhook signature"
      );

      return NextResponse.json(
        {
          success: false,
          message: "Missing webhook signature",
        },
        { status: 400 }
      );
    }

    // Generate the expected HMAC-SHA256 signature.
    const expectedSignature =
      crypto
        .createHmac("sha256", webhookSecret)
        .update(rawBody)
        .digest("hex");

    // Compare signatures safely.
    if (
      expectedSignature.length !==
        receivedSignature.length ||
      !crypto.timingSafeEqual(
        Buffer.from(expectedSignature),
        Buffer.from(receivedSignature)
      )
    ) {
      console.error(
        "Invalid Razorpay webhook signature"
      );

      return NextResponse.json(
        {
          success: false,
          message: "Invalid webhook signature",
        },
        { status: 400 }
      );
    }

    // Parse the webhook only after signature verification.
    const payload = JSON.parse(rawBody);

    const event = payload.event;

    console.log("=================================");
    console.log("Razorpay Billing Webhook Received");
    console.log("Event:", event);
    console.log("=================================");

    switch (event) {
      case "subscription.activated": {
        console.log(
          "Subscription activated:",
          payload?.payload?.subscription?.entity?.id
        );

        break;
      }

      case "subscription.pending": {
        console.log(
          "Subscription pending:",
          payload?.payload?.subscription?.entity?.id
        );

        break;
      }

      case "subscription.halted": {
        console.log(
          "Subscription halted:",
          payload?.payload?.subscription?.entity?.id
        );

        break;
      }

      case "subscription.charged": {
        console.log(
          "Subscription charged:",
          payload?.payload?.subscription?.entity?.id
        );

        break;
      }

      case "subscription.cancelled": {
        console.log(
          "Subscription cancelled:",
          payload?.payload?.subscription?.entity?.id
        );

        break;
      }

      case "subscription.completed": {
        console.log(
          "Subscription completed:",
          payload?.payload?.subscription?.entity?.id
        );

        break;
      }

      default: {
        console.log(
          "Unhandled Razorpay event:",
          event
        );
      }
    }

    return NextResponse.json({
      success: true,
      message: "Webhook received successfully",
    });
  } catch (error) {
    console.error(
      "Razorpay billing webhook error:",
      error
    );

    return NextResponse.json(
      {
        success: false,
        message: "Webhook processing failed",
      },
      { status: 500 }
    );
  }
}