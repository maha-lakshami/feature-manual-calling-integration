import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { razorpay } from "@/lib/razorpay";

const EXTRA_PERCENT = 25;

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    const {
      baseAmount,
      customerId,
      callId,
    } = body;

    const parsedBaseAmount = Number(baseAmount);

    if (
      !Number.isFinite(parsedBaseAmount) ||
      parsedBaseAmount <= 0
    ) {
      return NextResponse.json(
        {
          success: false,
          message:
            "A valid base amount greater than 0 is required",
        },
        { status: 400 }
      );
    }

    /*
     * Validate customer if provided.
     */
    if (customerId) {
      const customer =
        await prisma.customer.findUnique({
          where: {
            id: String(customerId),
          },
        });

      if (!customer) {
        return NextResponse.json(
          {
            success: false,
            message: "Customer not found",
          },
          { status: 404 }
        );
      }
    }

    /*
     * Validate call if provided.
     */
    if (callId) {
      const call =
        await prisma.call.findUnique({
          where: {
            id: String(callId),
          },
        });

      if (!call) {
        return NextResponse.json(
          {
            success: false,
            message: "Call not found",
          },
          { status: 404 }
        );
      }
    }

    /*
     * Calculate the 25% extra amount.
     *
     * Example:
     *
     * Base = ₹100
     * Extra = ₹25
     * Total = ₹125
     */
    const extraAmount =
      parsedBaseAmount *
      (EXTRA_PERCENT / 100);

    const totalAmount =
      parsedBaseAmount +
      extraAmount;

    /*
     * Razorpay uses paise.
     *
     * ₹1 = 100 paise
     */
    const baseAmountPaise =
      Math.round(parsedBaseAmount * 100);

    const extraAmountPaise =
      Math.round(extraAmount * 100);

    const totalAmountPaise =
      Math.round(totalAmount * 100);

    /*
     * Create Razorpay order.
     */
    const order =
      await razorpay.orders.create({
        amount: totalAmountPaise,
        currency: "INR",
        receipt: `crm_${Date.now()}`,
        notes: {
          customerId: customerId
            ? String(customerId)
            : "",
          callId: callId
            ? String(callId)
            : "",
          baseAmount:
            parsedBaseAmount.toFixed(2),
          extraPercent:
            String(EXTRA_PERCENT),
          extraAmount:
            extraAmount.toFixed(2),
          totalAmount:
            totalAmount.toFixed(2),
        },
      });

    /*
     * Save the payment in PostgreSQL.
     */
    const payment =
      await prisma.payment.create({
        data: {
          customerId:
            customerId
              ? String(customerId)
              : null,

          callId:
            callId
              ? String(callId)
              : null,

          baseAmountPaise,

          extraAmountPaise,

          totalAmountPaise,

          razorpayOrderId:
            order.id,

          status: "CREATED",
        },
      });

    console.log(
      "================================="
    );

    console.log(
      "Razorpay Order Created"
    );

    console.log(
      "Order ID:",
      order.id
    );

    console.log(
      "Payment ID:",
      payment.id
    );

    console.log(
      "Base Amount:",
      parsedBaseAmount
    );

    console.log(
      "25% Extra:",
      extraAmount
    );

    console.log(
      "Total Amount:",
      totalAmount
    );

    console.log(
      "================================="
    );

    return NextResponse.json({
      success: true,

      order: {
        id: order.id,
        amount: order.amount,
        currency: order.currency,
      },

      payment: {
        id: payment.id,
        baseAmount: parsedBaseAmount,
        extraAmount,
        extraPercent: EXTRA_PERCENT,
        totalAmount,
        baseAmountPaise,
        extraAmountPaise,
        totalAmountPaise,
      },

      razorpayKeyId:
        process.env
          .NEXT_PUBLIC_RAZORPAY_KEY_ID ||
        process.env.RAZORPAY_KEY_ID,
    });
  } catch (error) {
    console.error(
      "Razorpay create order error:",
      error
    );

    return NextResponse.json(
      {
        success: false,
        message:
          error instanceof Error
            ? error.message
            : "Failed to create Razorpay order",
      },
      { status: 500 }
    );
  }
}