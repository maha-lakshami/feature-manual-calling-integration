import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { prisma } from "@/lib/prisma";

export async function POST(request: NextRequest) {
  try {
    /*
     * IMPORTANT:
     * Razorpay webhook signature must be calculated
     * using the RAW request body.
     */
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
      return NextResponse.json(
        {
          success: false,
          message: "Missing Razorpay webhook signature",
        },
        { status: 400 }
      );
    }

    /*
     * ----------------------------------------------------------
     * Verify Razorpay webhook signature
     * ----------------------------------------------------------
     *
     * Razorpay uses:
     *
     * HMAC-SHA256
     * key     = webhook secret
     * message = raw request body
     */
    const expectedSignature =
      crypto
        .createHmac("sha256", webhookSecret)
        .update(rawBody)
        .digest("hex");

    if (
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

    /*
     * ----------------------------------------------------------
     * Parse webhook payload AFTER signature verification
     * ----------------------------------------------------------
     */
    const payload = JSON.parse(rawBody);

    const event = payload.event;

    console.log("=================================");
    console.log("Razorpay Webhook Received");
    console.log("Event:", event);
    console.log("=================================");

    /*
     * ----------------------------------------------------------
     * Handle payment.captured
     * ----------------------------------------------------------
     */
    if (event === "payment.captured") {
      const payment =
        payload?.payload?.payment?.entity;

      if (!payment) {
        return NextResponse.json(
          {
            success: false,
            message: "Payment data missing",
          },
          { status: 400 }
        );
      }

      const razorpayPaymentId = payment.id;
      const razorpayOrderId = payment.order_id;

      if (!razorpayOrderId) {
        console.error(
          "Webhook payment does not contain order_id"
        );

        return NextResponse.json(
          {
            success: false,
            message: "Razorpay order ID missing",
          },
          { status: 400 }
        );
      }

      /*
       * Find the payment created by our
       * /api/payments/create-order endpoint.
       */
      const existingPayment =
        await prisma.payment.findUnique({
          where: {
            razorpayOrderId,
          },
        });

      if (!existingPayment) {
        console.warn(
          "Payment record not found for order:",
          razorpayOrderId
        );

        /*
         * Return 200 so Razorpay does not repeatedly
         * retry a webhook for an order that our database
         * does not know about.
         */
        return NextResponse.json({
          success: true,
          message: "Webhook received",
        });
      }

      /*
       * Update the payment only if necessary.
       *
       * This also makes the handler safe if Razorpay
       * sends the same event more than once.
       */
      if (existingPayment.status !== "CAPTURED") {
        await prisma.payment.update({
          where: {
            id: existingPayment.id,
          },
          data: {
            razorpayPaymentId,
            status: "CAPTURED",
          },
        });

        console.log(
          "Payment status updated to CAPTURED"
        );
      } else {
        console.log(
          "Payment already CAPTURED - ignoring duplicate webhook"
        );
      }
    }

    /*
     * ----------------------------------------------------------
     * Handle payment.failed
     * ----------------------------------------------------------
     */
    else if (event === "payment.failed") {
      const payment =
        payload?.payload?.payment?.entity;

      if (!payment) {
        return NextResponse.json(
          {
            success: false,
            message: "Payment data missing",
          },
          { status: 400 }
        );
      }

      const razorpayPaymentId = payment.id;
      const razorpayOrderId = payment.order_id;

      if (razorpayOrderId) {
        const existingPayment =
          await prisma.payment.findUnique({
            where: {
              razorpayOrderId,
            },
          });

        if (existingPayment) {
          await prisma.payment.update({
            where: {
              id: existingPayment.id,
            },
            data: {
              razorpayPaymentId,
              status: "FAILED",
            },
          });

          console.log(
            "Payment status updated to FAILED"
          );
        }
      }
    }

    /*
     * ----------------------------------------------------------
     * Handle refund.processed
     * ----------------------------------------------------------
     */
    else if (event === "refund.processed") {
      const payment =
        payload?.payload?.payment?.entity;

      if (payment) {
        const razorpayPaymentId = payment.id;

        const existingPayment =
          await prisma.payment.findUnique({
            where: {
              razorpayPaymentId,
            },
          });

        if (existingPayment) {
          await prisma.payment.update({
            where: {
              id: existingPayment.id,
            },
            data: {
              status: "REFUNDED",
            },
          });

          console.log(
            "Payment status updated to REFUNDED"
          );
        }
      }
    }

    /*
     * ----------------------------------------------------------
     * Ignore events that this application does not need.
     * ----------------------------------------------------------
     */
    else {
      console.log(
        "Webhook event received but not handled:",
        event
      );
    }

    /*
     * Razorpay expects a successful 2xx response.
     */
    return NextResponse.json({
      success: true,
      message: "Webhook received successfully",
    });
  } catch (error) {
    console.error(
      "Razorpay webhook error:",
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