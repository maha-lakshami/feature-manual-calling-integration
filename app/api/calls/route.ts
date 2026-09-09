import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { plivoClient } from "@/lib/plivo";

/*
 * =========================================================
 * POST /api/calls
 *
 * Starts a manual outbound call.
 *
 * Flow:
 *
 * CRM
 *   ↓
 * Plivo calls salesperson
 *   ↓
 * Salesperson answers
 *   ↓
 * Answer webhook connects salesperson to customer
 *   ↓
 * Plivo audio stream
 *   ↓
 * Gemini Live
 * =========================================================
 */

export async function POST(
  request: NextRequest
) {
  try {
    const body =
      await request.json();

    const {
      customerId,
      salespersonId,
    } = body;

    if (!customerId) {
      return NextResponse.json(
        {
          success: false,
          error:
            "customerId is required",
        },
        {
          status: 400,
        }
      );
    }

    /* =====================================================
       FIND CUSTOMER
       ===================================================== */

    const customer =
      await prisma.customer.findUnique({
        where: {
          id: customerId,
        },
      });

    if (!customer) {
      return NextResponse.json(
        {
          success: false,
          error:
            "Customer not found",
        },
        {
          status: 404,
        }
      );
    }

    /* =====================================================
       SALESPERSON
       ===================================================== */

    const actualSalespersonId =
      salespersonId ||
      customer.assignedTo ||
      "sales-001";

    /* =====================================================
       ENVIRONMENT VARIABLES
       ===================================================== */

    const publicBaseUrl =
      process.env.PLIVO_PUBLIC_BASE_URL;

    const plivoPhoneNumber =
      process.env.PLIVO_PHONE_NUMBER;

    const salespersonPhoneNumber =
      process.env.SALESPERSON_PHONE_NUMBER;

    if (!publicBaseUrl) {
      throw new Error(
        "PLIVO_PUBLIC_BASE_URL is not configured"
      );
    }

    if (!plivoPhoneNumber) {
      throw new Error(
        "PLIVO_PHONE_NUMBER is not configured"
      );
    }

    if (!salespersonPhoneNumber) {
      throw new Error(
        "SALESPERSON_PHONE_NUMBER is not configured"
      );
    }

    /* =====================================================
       ANSWER WEBHOOK
       ===================================================== */

    const answerUrl =
      `${publicBaseUrl}/api/calls/answer` +
      `?customerId=${encodeURIComponent(
        customer.id
      )}` +
      `&customerPhone=${encodeURIComponent(
        customer.phone
      )}`;

    /* =====================================================
       CREATE PLIVO CALL
       ===================================================== */

    const plivoResponse =
      await plivoClient.calls.create(
        plivoPhoneNumber,
        salespersonPhoneNumber,
        answerUrl,
        {
          answerMethod: "POST",

          hangupUrl:
            `${publicBaseUrl}/api/calls/status`,

          hangupMethod: "POST",
        }
      );

    /* =====================================================
       PROVIDER CALL ID
       ===================================================== */

    const providerCallId =
      Array.isArray(
        plivoResponse.requestUuid
      )
        ? plivoResponse.requestUuid[0]
        : plivoResponse.requestUuid;

    /* =====================================================
       SAVE CRM CALL
       ===================================================== */

    const call =
      await prisma.call.create({
        data: {
          customerId:
            customer.id,

          salespersonId:
            actualSalespersonId,

          provider:
            "plivo",

          providerCallId,

          status:
            "INITIATING",

          startedAt:
            new Date(),
        },
      });

    console.log(
      "================================="
    );

    console.log(
      "Manual Call Initiated"
    );

    console.log(
      "Customer:",
      customer.name
    );

    console.log(
      "Customer Phone:",
      customer.phone
    );

    console.log(
      "Salesperson Phone:",
      salespersonPhoneNumber
    );

    console.log(
      "Provider Call ID:",
      providerCallId
    );

    console.log(
      "CRM Call ID:",
      call.id
    );

    console.log(
      "================================="
    );

    return NextResponse.json({
      success: true,

      message:
        "Manual call initiated successfully",

      call,

      plivo:
        plivoResponse,
    });
  } catch (error) {
    console.error(
      "Call initiation error:",
      error
    );

    return NextResponse.json(
      {
        success: false,

        error:
          error instanceof Error
            ? error.message
            : "Failed to initiate call",
      },
      {
        status: 500,
      }
    );
  }
}

/*
 * =========================================================
 * GET /api/calls
 *
 * Returns all calls.
 *
 * Also supports:
 *
 * GET /api/calls?providerCallId=xxxxx
 *
 * This is used by voice-server.mjs to convert
 * the Plivo provider call ID into our CRM call ID.
 * =========================================================
 */

export async function GET(
  request: NextRequest
) {
  try {
    const {
      searchParams,
    } = new URL(
      request.url
    );

    const providerCallId =
      searchParams.get(
        "providerCallId"
      );

    /* =====================================================
       WHERE CONDITION
       ===================================================== */

    const where =
      providerCallId
        ? {
            providerCallId,
          }
        : undefined;

    /* =====================================================
       GET CALLS
       ===================================================== */

    const calls =
      await prisma.call.findMany({
        where,

        include: {
          customer: true,

          aiAnalysis: true,

          followUpTask: true,
        },

        orderBy: {
          createdAt:
            "desc",
        },
      });

    return NextResponse.json({
      success: true,

      calls,
    });
  } catch (error) {
    console.error(
      "Call loading error:",
      error
    );

    return NextResponse.json(
      {
        success: false,

        message:
          error instanceof Error
            ? error.message
            : "Failed to load calls",
      },
      {
        status: 500,
      }
    );
  }
}