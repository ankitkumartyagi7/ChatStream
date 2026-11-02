import React, { useState, useRef, useEffect } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

const API_BASE_URL = "http://localhost:8000";

async function requestJson(path, options = {}) {
  const response = await fetch(`${API_BASE_URL}${path}`, options);

  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }

  return response.json();
}

function getSessionId(session) {
  if (typeof session === "string") return session;
  return session?.session_id ?? session?.id;
}

function getSessionLabel(session) {
  if (typeof session === "string") return session;
  return session?.title ?? session?.name ?? getSessionId(session) ?? "Untitled chat";
}

function normalizeMessages(messages) {
  if (!Array.isArray(messages)) {
    throw new Error("The session history response did not contain a messages list.");
  }

  return messages.map((message) => ({
    role: message.role ?? "assistant",
    content: message.content ?? message.text ?? "",
  }));
}

async function* streamResponse({ message, sessionId }) {
  const response = await fetch(`${API_BASE_URL}/api/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      message,
      session_id: sessionId,
      arguments: { query: message },
    }),
  });

  if (!response.ok || !response.body) {
    throw new Error(`Request failed: ${response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();

    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    const events = buffer.split("\n\n");
    buffer = events.pop();

    for (const rawEvent of events) {
      let eventName = "message";
      let data = "";

      for (const line of rawEvent.split("\n")) {
        if (line.startsWith("event:")) {
          eventName = line.replace("event:", "").trim();
        } else if (line.startsWith("data:")) {
          data += line.replace("data:", "").trim();
        }
      }

      if (!data) continue;

      const parsed = JSON.parse(data);

      if (eventName === "token") {
        yield parsed.text;
      } else if (eventName === "error") {
        throw new Error(parsed.message);
      }
    }
  }
}

export default function ChatUI() {
  const [sessions, setSessions] = useState([]);
  const [activeSessionId, setActiveSessionId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [isLoadingSessions, setIsLoadingSessions] = useState(true);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const [error, setError] = useState("");
  const containerRef = useRef(null);

  useEffect(() => {
    let isMounted = true;

    async function loadSessions() {
      try {
        const result = await requestJson("/api/sessions");
        if (!Array.isArray(result.sessions)) {
          throw new Error("The sessions response did not contain a sessions list.");
        }
        if (!isMounted) return;

        setSessions(result.sessions);
        const firstSessionId = result.sessions[0] && getSessionId(result.sessions[0]);
        if (firstSessionId) {
          setActiveSessionId(firstSessionId);
        }
      } catch (loadError) {
        if (isMounted) setError(loadError.message);
      } finally {
        if (isMounted) setIsLoadingSessions(false);
      }
    }

    loadSessions();
    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    if (!activeSessionId) {
      setMessages([]);
      return;
    }

    let isCurrent = true;
    setIsLoadingHistory(true);
    setError("");

    async function loadHistory() {
      try {
        const result = await requestJson(
          `/api/sessions/${encodeURIComponent(activeSessionId)}/messages`,
        );
        if (isCurrent) setMessages(normalizeMessages(result.messages));
      } catch (loadError) {
        if (isCurrent) {
          setMessages([]);
          setError(loadError.message);
        }
      } finally {
        if (isCurrent) setIsLoadingHistory(false);
      }
    }

    loadHistory();
    return () => {
      isCurrent = false;
    };
  }, [activeSessionId]);

  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollTo({
        top: containerRef.current.scrollHeight,
        behavior: "smooth",
      });
    }
  }, [messages]);

  const refreshSessions = async () => {
    const result = await requestJson("/api/sessions");
    if (!Array.isArray(result.sessions)) {
      throw new Error("The sessions response did not contain a sessions list.");
    }
    setSessions(result.sessions);
  };

  const createSession = async () => {
    setError("");
    try {
      const createdSession = await requestJson("/api/sessions", { method: "POST" });
      const sessionId = getSessionId(createdSession);
      if (!sessionId) {
        throw new Error("The create session response did not contain a session ID.");
      }

      setSessions((currentSessions) => [
        createdSession,
        ...currentSessions.filter((session) => getSessionId(session) !== sessionId),
      ]);
      setActiveSessionId(sessionId);
      setMessages([]);
      setInput("");
    } catch (createError) {
      setError(createError.message);
    }
  };

  const deleteSession = async (event, sessionId) => {
    event.stopPropagation();
    setError("");

    try {
      await requestJson(`/api/sessions/${encodeURIComponent(sessionId)}`, {
        method: "DELETE",
      });
      const remainingSessions = sessions.filter(
        (session) => getSessionId(session) !== sessionId,
      );
      setSessions(remainingSessions);

      if (activeSessionId === sessionId) {
        setActiveSessionId(remainingSessions[0] ? getSessionId(remainingSessions[0]) : null);
      }
    } catch (deleteError) {
      setError(deleteError.message);
    }
  };

  const sendMessage = async () => {
    const message = input.trim();
    if (!message || isStreaming || !activeSessionId) return;

    const userMessage = { role: "user", content: message };
    const botMessage = { role: "assistant", content: "" };

    setMessages((previousMessages) => [...previousMessages, userMessage, botMessage]);
    setInput("");
    setIsStreaming(true);
    setError("");

    let accumulated = "";

    try {
      for await (const chunk of streamResponse({ message, sessionId: activeSessionId })) {
        accumulated += chunk;

        setMessages((previousMessages) => {
          const updatedMessages = [...previousMessages];
          updatedMessages[updatedMessages.length - 1] = {
            role: "assistant",
            content: accumulated,
          };
          return updatedMessages;
        });
      }
      await refreshSessions();
    } catch (sendError) {
      setError(sendError.message);
      if (!accumulated) {
        setMessages((previousMessages) => previousMessages.slice(0, -1));
      }
    } finally {
      setIsStreaming(false);
    }
  };

  return (
    <div className="h-screen flex bg-gray-100 text-gray-500">
      <aside className="w-72 flex-shrink-0 flex flex-col bg-gray-900 text-gray-100">
        <div className="p-4 border-b border-gray-700">
          <button
            type="button"
            onClick={createSession}
            disabled={isStreaming}
            className="w-full rounded-lg border border-gray-600 px-4 py-3 text-left hover:bg-gray-800 disabled:opacity-50"
          >
            <span className="mr-2 text-lg">+</span>
            New chat
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-3">
          <h2 className="px-2 pb-2 text-xs font-semibold uppercase tracking-wide text-gray-400">
            Sessions
          </h2>
          {isLoadingSessions ? (
            <p className="px-2 py-3 text-sm text-gray-400">Loading sessions...</p>
          ) : sessions.length === 0 ? (
            <p className="px-2 py-3 text-sm text-gray-400">No sessions yet</p>
          ) : (
            <ul className="space-y-1">
              {sessions.map((session) => {
                const sessionId = getSessionId(session);
                if (!sessionId) return null;

                return (
                  <li key={sessionId}>
                    <div
                      className={`group flex items-center rounded-lg ${
                        activeSessionId === sessionId ? "bg-gray-700" : "hover:bg-gray-800"
                      }`}
                    >
                      <button
                        type="button"
                        onClick={() => setActiveSessionId(sessionId)}
                        disabled={isStreaming}
                        className="min-w-0 flex-1 truncate px-3 py-2 text-left text-sm"
                        title={getSessionLabel(session)}
                      >
                        {getSessionLabel(session)}
                      </button>
                      <button
                        type="button"
                        onClick={(event) => deleteSession(event, sessionId)}
                        disabled={isStreaming}
                        aria-label={`Delete ${getSessionLabel(session)}`}
                        title="Delete session"
                        className="mr-1 rounded px-2 py-1 text-gray-400 hover:bg-red-600 hover:text-white disabled:opacity-50"
                      >
                        ×
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">
        {error && (
          <div role="alert" className="border-b border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        )}

        <div
          ref={containerRef}
          className="flex-1 overflow-y-auto p-4 space-y-4"
        >
          {isLoadingHistory ? (
            <p className="text-center text-sm text-gray-500">Loading conversation...</p>
          ) : !activeSessionId ? (
          <div className="flex h-full flex-col gap-4 overflow-y-auto p-4 text-gray-500">
            <b className="mb-2 block text-gray-500">Questions you can ask the AI assistant:</b>

            <section>
              <b className="mb-2 block text-gray-500">Work orders</b>
              <ul className="list-disc space-y-1 pl-5">
                <li>Which work orders are delayed?</li>
                <li>Show work orders for plant 1.</li>
                <li>What is the status of work order WO-1001?</li>
                <li>Show operations, materials, and exceptions for this work order.</li>
              </ul>
            </section>

            <section>
              <b className="mb-2 block text-gray-500">Inventory and materials</b>
              <ul className="list-disc space-y-1 pl-5">
                <li>Which materials are short?</li>
                <li>Is item ITEM-100 available at plant 1?</li>
                <li>What components are required for this work order?</li>
                <li>How much inventory is available after reservations?</li>
              </ul>
            </section>

            <section>
              <b className="mb-2 block text-gray-500">Operations and production</b>
              <ul className="list-disc space-y-1 pl-5">
                <li>What is the history of operation 25?</li>
                <li>Which operations are currently in progress?</li>
                <li>How much good quantity was produced?</li>
                <li>Which operations are paused or completed?</li>
              </ul>
            </section>

            <section>
              <b className="mb-2 block text-gray-500">Workstations</b>
              <ul className="list-disc space-y-1 pl-5">
                <li>How many workstations are there?</li>
                <li>Show workstations for plant 1.</li>
                <li>What operations are running at workstation WS-01?</li>
              </ul>
            </section>

            <section>
              <b className="mb-2 block text-gray-500">Exceptions</b>
              <ul className="list-disc space-y-1 pl-5">
                <li>Show all open production exceptions.</li>
                <li>Are there any critical machine breakdowns?</li>
                <li>Show quality issues for workstation WS-01.</li>
                <li>Create a material shortage exception.</li>
                <li>Resolve exception 12.</li>
              </ul>
            </section>

            <section>
              <b className="mb-2 block text-gray-500">Operators and shifts</b>
              <ul className="list-disc space-y-1 pl-5">
                <li>Show the shift history for operator 10.</li>
                <li>Which operator worked during this shift?</li>
                <li>Show production performance by operator.</li>
                <li>How many good and rejected units were produced?</li>
              </ul>
            </section>

            <section>
              <b className="mb-2 block text-gray-500">Counts and status summaries</b>
              <ul className="list-disc space-y-1 pl-5">
                <li>How many work orders are there?</li>
                <li>How many operations are in progress?</li>
                <li>Show work orders grouped by status.</li>
                <li>How many workstations are available at plant 1?</li>
              </ul>
            </section>

            <section>
              <b className="mb-2 block text-gray-500">Production actions</b>
              <ul className="list-disc space-y-1 pl-5">
                <li>Start operation 25.</li>
                <li>Pause operation 25.</li>
                <li>Complete operation 25.</li>
                <li>Report 100 good units and 5 rejected units.</li>
                <li>Create a machine breakdown exception.</li>
              </ul>
            </section>
          </div>

          ) : (
            messages.map((msg, index) => (
              <div
                key={`${activeSessionId}-${index}`}
                className={`flex ${
                  msg.role === "user" ? "justify-end" : "justify-start"
                }`}
              >
                <div
                  className={`px-4 py-2 rounded-2xl max-w-xl text-sm shadow ${
                    msg.role === "user"
                      ? "bg-blue-500 text-white"
                      : "bg-white text-gray-800"
                  }`}
                >
                  <div className="markdown-message">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>
                      {msg.content}
                    </ReactMarkdown>
                  </div>
                </div>
              </div>
            ))
          )}
        </div>

       { activeSessionId ? (
          <div className="p-4 bg-white border-t flex gap-2">
            <input
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                sendMessage();
              }
            }}
            disabled={!activeSessionId || isLoadingHistory}
            className="flex-1 border rounded-xl px-4 py-2 outline-none disabled:bg-gray-100"
            placeholder={activeSessionId ? "Type your message..." : "Create a chat to start"}
          />
          <button
            type="button"
            onClick={sendMessage}
            disabled={isStreaming || !activeSessionId || isLoadingHistory}
            className="bg-blue-500 text-white px-4 py-2 rounded-xl disabled:opacity-50"
          >
            Send
          </button>
        </div>
       ): ''}
      </main>
    </div>
  );
}
