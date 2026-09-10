"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

type TranscriptEntry = {
  id: string;
  speaker: "customer" | "salesperson";
  text: string;
  timestamp: string;
};

type Call = {
  id: string;
  customerId: string;
  salespersonId: string;
  provider: string;
  status: string;
  startedAt: string | null;
  endedAt: string | null;
  durationSeconds: number | null;
  createdAt: string;

  customer: {
    name: string;
    phone: string;
    email: string | null;
  };

  aiAnalysis: {
    summary: string;
    outcome: string;
    interest: string;
    nextAction: string;
    requirement?: string | null;
    objection?: string | null;
    priority?: string | null;
    reason?: string | null;
    confidence?: number | null;
  } | null;
};

export default function CallHistoryPage() {
  const router = useRouter();

  const [calls, setCalls] = useState<Call[]>([]);
  const [loading, setLoading] = useState(true);

  const [selectedCall, setSelectedCall] = useState<Call | null>(null);
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [transcriptLoading, setTranscriptLoading] = useState(false);

  useEffect(() => {
    loadHistory();
  }, []);

  async function loadHistory() {
    try {
      const response = await fetch("/api/calls");
      const data = await response.json();

      if (data.success) {
        setCalls(data.calls || []);
      }
    } catch (error) {
      console.error("Failed to load call history:", error);
    } finally {
      setLoading(false);
    }
  }

  async function openConversation(call: Call) {
    setSelectedCall(call);
    setTranscript([]);
    setTranscriptLoading(true);

    try {
      const response = await fetch(
        `/api/calls/${call.id}/transcript`
      );

      const data = await response.json();

      if (data.success) {
        setTranscript(data.entries || []);
      }
    } catch (error) {
      console.error(
        "Failed to load transcript:",
        error
      );
    } finally {
      setTranscriptLoading(false);
    }
  }

  function closeConversation() {
    setSelectedCall(null);
    setTranscript([]);
  }

  function formatDate(date: string | null) {
    if (!date) return "—";

    const formatted = new Date(date).toLocaleString(
      "en-IN",
      {
        day: "2-digit",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }
    );

    return formatted;
  }

  function formatDuration(seconds: number | null) {
    if (
      seconds === null ||
      seconds === undefined
    ) {
      return "—";
    }

    if (seconds < 60) {
      return `${seconds} sec`;
    }

    const minutes = Math.floor(seconds / 60);
    const remaining = seconds % 60;

    if (remaining === 0) {
      return `${minutes} min`;
    }

    return `${minutes}m ${remaining}s`;
  }

  function getStatusClass(status: string) {
    switch (status) {
      case "COMPLETED":
        return "bg-green-50 text-green-600";

      case "FAILED":
      case "BUSY":
      case "NO_ANSWER":
        return "bg-red-50 text-red-600";

      case "CONNECTED":
        return "bg-blue-50 text-blue-600";

      default:
        return "bg-amber-50 text-amber-600";
    }
  }

  function formatLabel(value: string | null | undefined) {
    if (!value) return "—";

    return value
      .replace(/_/g, " ")
      .toLowerCase()
      .replace(/\b\w/g, (char) =>
        char.toUpperCase()
      );
  }

  const totalDuration = calls.reduce(
    (total, call) =>
      total + (call.durationSeconds || 0),
    0
  );

  return (
    <div className="min-h-screen bg-[#f7f8fa] text-[#172033]">

      {/* Header */}
      <header className="border-b border-[#e8ebef] bg-white">
        <div className="mx-auto max-w-[1400px] px-8 py-6">
          <h1 className="text-2xl font-semibold">
            Call History
          </h1>

          <p className="mt-1 text-sm text-[#6b7485]">
            View the history of all customer calls
          </p>
        </div>
      </header>

      {/* Main */}
      <main className="mx-auto max-w-[1400px] px-8 py-8">

        {/* Statistics */}
        <div className="mb-7 grid gap-4 md:grid-cols-3">

          <div className="rounded-2xl border border-[#e6e9ee] bg-white p-6">
            <p className="text-sm text-[#7b8494]">
              Total Calls
            </p>

            <p className="mt-2 text-3xl font-semibold">
              {calls.length}
            </p>
          </div>

          <div className="rounded-2xl border border-[#e6e9ee] bg-white p-6">
            <p className="text-sm text-[#7b8494]">
              Completed
            </p>

            <p className="mt-2 text-3xl font-semibold text-green-600">
              {
                calls.filter(
                  (call) =>
                    call.status === "COMPLETED"
                ).length
              }
            </p>
          </div>

          <div className="rounded-2xl border border-[#e6e9ee] bg-white p-6">
            <p className="text-sm text-[#7b8494]">
              Total Duration
            </p>

            <p className="mt-2 text-3xl font-semibold text-blue-600">
              {Math.floor(totalDuration / 60)} min
            </p>
          </div>
        </div>

        {/* Table */}
        {loading ? (
          <div className="rounded-2xl border border-[#e6e9ee] bg-white p-10 text-center">
            <p className="text-sm text-[#6b7485]">
              Loading call history...
            </p>
          </div>
        ) : calls.length === 0 ? (
          <div className="rounded-2xl border border-[#e6e9ee] bg-white p-10 text-center">
            <h2 className="font-semibold">
              No call history
            </h2>

            <p className="mt-2 text-sm text-[#7b8494]">
              Customer calls will appear here.
            </p>
          </div>
        ) : (
          <div className="overflow-hidden rounded-2xl border border-[#e6e9ee] bg-white">

            <div className="overflow-x-auto">

              <table className="w-full min-w-[1100px]">

                <thead>
                  <tr className="border-b border-[#eef0f3] bg-[#fafbfc] text-left">

                    {/* CLIENT / PHONE */}
                    <th className="px-5 py-4 text-xs font-semibold uppercase tracking-wide text-[#8b94a3]">
                      Client / Phone
                    </th>

                    {/* STATUS */}
                    <th className="px-5 py-4 text-xs font-semibold uppercase tracking-wide text-[#8b94a3]">
                      Status
                    </th>

                    {/* DURATION */}
                    <th className="px-5 py-4 text-xs font-semibold uppercase tracking-wide text-[#8b94a3]">
                      Duration
                    </th>

                    {/* DATE */}
                    <th className="px-5 py-4 text-xs font-semibold uppercase tracking-wide text-[#8b94a3]">
                      Date
                    </th>

                    {/* AI SUMMARY */}
                    <th className="px-5 py-4 text-xs font-semibold uppercase tracking-wide text-[#8b94a3]">
                      AI Summary & Next Action
                    </th>

                    {/* ACTION */}
                    <th className="px-5 py-4 text-xs font-semibold uppercase tracking-wide text-[#8b94a3]">
                      Actions
                    </th>

                  </tr>
                </thead>

                <tbody>

                  {calls.map((call) => (

                    <tr
                      key={call.id}
                      className="border-b border-[#f0f1f3] last:border-b-0 hover:bg-[#fcfcfd]"
                    >

                      {/* CLIENT / PHONE */}
                      <td className="px-5 py-5">

                        <p className="font-semibold">
                          {call.customer.name}
                        </p>

                        <p className="mt-1 text-sm text-[#7b8494]">
                          {call.customer.phone}
                        </p>

                      </td>

                      {/* STATUS */}
                      <td className="px-5 py-5">

                        <span
                          className={`inline-flex rounded-full px-3 py-1 text-xs font-semibold ${getStatusClass(
                            call.status
                          )}`}
                        >
                          {call.status}
                        </span>

                      </td>

                      {/* DURATION */}
                      <td className="px-5 py-5 text-sm text-[#4b5565]">
                        {formatDuration(
                          call.durationSeconds
                        )}
                      </td>

                      {/* DATE */}
                      <td className="px-5 py-5 text-sm text-[#4b5565]">
                        {formatDate(call.startedAt)}
                      </td>

                      {/* AI SUMMARY */}
                      <td className="px-5 py-5">

                        {call.aiAnalysis ? (

                          <button
                            type="button"
                            onClick={() =>
                              openConversation(call)
                            }
                            className="block max-w-[390px] text-left"
                          >

                            <p className="line-clamp-2 text-sm font-medium text-[#172033] hover:text-blue-600">
                              {call.aiAnalysis.summary}
                            </p>

                            <p className="mt-2 text-xs font-medium text-[#6b7485]">
                              → Next:{" "}
                              <span className="text-[#4b5565]">
                                {formatLabel(
                                  call.aiAnalysis
                                    .nextAction
                                )}
                              </span>
                            </p>

                            <p className="mt-1 text-[11px] text-blue-600">
                              Click to view conversation
                            </p>

                          </button>

                        ) : (

                          <button
                            type="button"
                            onClick={() =>
                              openConversation(call)
                            }
                            className="text-left"
                          >
                            <p className="text-sm italic text-[#9aa2b1]">
                              Processing transcript...
                            </p>

                            <p className="mt-1 text-[11px] text-blue-600">
                              Click to view conversation
                            </p>
                          </button>

                        )}

                      </td>

                      {/* ACTION */}
                      <td className="px-5 py-5">

                        <button
                          type="button"
                          onClick={() =>
                            router.push(
                              `/customers/${call.customerId}`
                            )
                          }
                          className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-blue-700"
                        >
                          View Details
                        </button>

                      </td>

                    </tr>

                  ))}

                </tbody>

              </table>

            </div>

          </div>
        )}

      </main>

      {/* =====================================================
          CONVERSATION MODAL
          ===================================================== */}

      {selectedCall && (

        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-5"
          onClick={closeConversation}
        >

          <div
            className="flex max-h-[90vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl"
            onClick={(event) =>
              event.stopPropagation()
            }
          >

            {/* Modal Header */}
            <div className="flex items-center justify-between border-b border-[#e8ebef] px-6 py-5">

              <div>

                <h2 className="text-xl font-semibold">
                  Call Conversation
                </h2>

                <p className="mt-1 text-sm text-[#7b8494]">
                  {selectedCall.customer.name} ·{" "}
                  {selectedCall.customer.phone}
                </p>

              </div>

              <button
                type="button"
                onClick={closeConversation}
                className="flex h-9 w-9 items-center justify-center rounded-full bg-[#f3f4f6] text-lg text-[#6b7280] hover:bg-[#e5e7eb]"
              >
                ×
              </button>

            </div>

            {/* Call Information */}
            <div className="grid grid-cols-3 gap-4 border-b border-[#eef0f3] bg-[#fafbfc] px-6 py-4">

              <div>
                <p className="text-xs text-[#8b94a3]">
                  STATUS
                </p>

                <p className="mt-1 text-sm font-semibold">
                  {selectedCall.status}
                </p>
              </div>

              <div>
                <p className="text-xs text-[#8b94a3]">
                  DURATION
                </p>

                <p className="mt-1 text-sm font-semibold">
                  {formatDuration(
                    selectedCall.durationSeconds
                  )}
                </p>
              </div>

              <div>
                <p className="text-xs text-[#8b94a3]">
                  DATE
                </p>

                <p className="mt-1 text-sm font-semibold">
                  {formatDate(
                    selectedCall.startedAt
                  )}
                </p>
              </div>

            </div>

            {/* AI Information */}
            {selectedCall.aiAnalysis && (

              <div className="border-b border-[#eef0f3] px-6 py-5">

                <h3 className="text-sm font-semibold">
                  AI Summary & Next Action
                </h3>

                <p className="mt-2 text-sm leading-6 text-[#4b5565]">
                  {selectedCall.aiAnalysis.summary}
                </p>

                <div className="mt-3 rounded-xl bg-blue-50 px-4 py-3">

                  <p className="text-xs font-semibold uppercase tracking-wide text-blue-600">
                    Next Action
                  </p>

                  <p className="mt-1 text-sm font-medium text-[#172033]">
                    {formatLabel(
                      selectedCall.aiAnalysis
                        .nextAction
                    )}
                  </p>

                </div>

              </div>

            )}

            {/* Conversation */}
            <div className="flex-1 overflow-y-auto px-6 py-6">

              <h3 className="mb-5 text-sm font-semibold">
                Complete Conversation
              </h3>

              {transcriptLoading ? (

                <div className="py-10 text-center">
                  <p className="text-sm text-[#7b8494]">
                    Loading conversation...
                  </p>
                </div>

              ) : transcript.length === 0 ? (

                <div className="rounded-xl border border-dashed border-[#d9dde4] p-8 text-center">

                  <p className="text-sm font-medium text-[#6b7485]">
                    No transcript available
                  </p>

                  <p className="mt-1 text-xs text-[#9aa2b1]">
                    The conversation transcript has
                    not been recorded yet.
                  </p>

                </div>

              ) : (

                <div className="space-y-5">

                  {transcript.map((entry) => {

                    const isSalesperson =
                      entry.speaker ===
                      "salesperson";

                    return (

                      <div
                        key={entry.id}
                        className={`flex ${
                          isSalesperson
                            ? "justify-end"
                            : "justify-start"
                        }`}
                      >

                        <div
                          className={`max-w-[75%] rounded-2xl px-4 py-3 ${
                            isSalesperson
                              ? "bg-blue-600 text-white"
                              : "bg-[#f1f3f5] text-[#172033]"
                          }`}
                        >

                          <p
                            className={`mb-1 text-xs font-semibold ${
                              isSalesperson
                                ? "text-blue-100"
                                : "text-[#6b7485]"
                            }`}
                          >
                            {isSalesperson
                              ? "Salesperson"
                              : "Customer"}
                          </p>

                          <p className="text-sm leading-6">
                            {entry.text}
                          </p>

                          <p
                            className={`mt-1 text-[10px] ${
                              isSalesperson
                                ? "text-blue-100"
                                : "text-[#9aa2b1]"
                            }`}
                          >
                            {new Date(
                              entry.timestamp
                            ).toLocaleTimeString(
                              "en-IN",
                              {
                                hour: "2-digit",
                                minute: "2-digit",
                              }
                            )}
                          </p>

                        </div>

                      </div>

                    );
                  })}

                </div>

              )}

            </div>

            {/* Modal Footer */}
            <div className="flex justify-end gap-3 border-t border-[#e8ebef] px-6 py-4">

              <button
                type="button"
                onClick={closeConversation}
                className="rounded-lg border border-[#dfe3e8] px-4 py-2 text-sm font-medium text-[#4b5565] hover:bg-[#f7f8fa]"
              >
                Close
              </button>

              <button
                type="button"
                onClick={() =>
                  router.push(
                    `/customers/${selectedCall.customerId}`
                  )
                }
                className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
              >
                View Customer Details
              </button>

            </div>

          </div>

        </div>

      )}

    </div>
  );
}