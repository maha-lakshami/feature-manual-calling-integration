import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { prisma } from "@/lib/prisma";

export async function POST(
  request: NextRequest
) {
  try {
    const body = await request.json();

    const {
      razorpay_payment_id,
      razorpay_order_id,
      razorpay_signature,
    } = body;

    if (
      !razorpay_payment_id ||
      !razorpay_order_id ||
      !razorpay_signature
    ) {
      return NextResponse.json(
        {
          success: false,
          message:
            "Payment verification details are required",
        },
        { status: 400 }
      );
    }

    /*
     * IMPORTANT:
     *
     * Get the order from OUR database.
     * Do not trust the order ID sent by the browser.
     */
    const payment =
      await prisma.payment.findUnique({
        where: {
          razorpayOrderId:
            razorpay_order_id,
        },
      });

    if (!payment) {
      return NextResponse.json(
        {
          success: false,
          message:
            "Payment order not found",
        },
        { status: 404 }
      );
    }

    const keySecret =
      process.env.RAZORPAY_KEY_SECRET;

    if (!keySecret) {
      return NextResponse.json(
        {
          success: false,
          message:
            "Razorpay key secret is not configured",
        },
        { status: 500 }
      );
    }

    /*
     * Razorpay signature:
     *
     * HMAC-SHA256(
     *   order_id + "|" + payment_id,
     *   key_secret
     * )
     */
    const generatedSignature =
      crypto
        .createHmac(
          "sha256",
          keySecret
        )
        .update(
          `${payment.razorpayOrderId}|${razorpay_payment_id}`
        )
        .digest("hex");

    /*
     * Timing-safe comparison.
     */
    const generatedBuffer =
      Buffer.from(
        generatedSignature,
        "utf8"
      );

    const receivedBuffer =
      Buffer.from(
        razorpay_signature,
        "utf8"
      );

    if (
      generatedBuffer.length !==
      receivedBuffer.length
    ) {
      return NextResponse.json(
        {
          success: false,
          message:
            "Invalid payment signature",
        },
        { status: 400 }
      );
    }

    const signatureValid =
      crypto.timingSafeEqual(
        generatedBuffer,
        receivedBuffer
      );

    if (!signatureValid) {
      await prisma.payment.update({
        where: {
          id: payment.id,
        },

        data: {
          status: "FAILED",
        },
      });

      return NextResponse.json(
        {
          success: false,
          message:
            "Payment signature verification failed",
        },
        { status: 400 }
      );
    }

    /*
     * Signature is valid.
     * Store the Razorpay payment ID.
     */
    const updatedPayment =
      await prisma.payment.update({
        where: {
          id: payment.id,
        },

        data: {
          razorpayPaymentId:
            razorpay_payment_id,

          razorpaySignature:
            razorpay_signature,

          status: "CAPTURED",

        },
      });

    console.log(
      "================================="
    );

    console.log(
      "Razorpay Payment Verified"
    );

    console.log(
      "Payment ID:",
      razorpay_payment_id
    );

    console.log(
      "Order ID:",
      razorpay_order_id
    );

    console.log(
      "Payment Record:",
      updatedPayment.id
    );

    console.log(
      "Status:",
      updatedPayment.status
    );

    console.log(
      "================================="
    );

    return NextResponse.json({
      success: true,

      message:
        "Payment verified successfully",

      payment: updatedPayment,
    });
  } catch (error) {
    console.error(
      "Payment verification error:",
      error
    );

    return NextResponse.json(
      {
        success: false,

        message:
          error instanceof Error
            ? error.message
            : "Failed to verify payment",
      },
      { status: 500 }
    );
  }
}