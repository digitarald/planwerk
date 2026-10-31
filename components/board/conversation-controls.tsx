"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Loader2, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { ChatUsage, ConversationDetails, KanbanCard } from "@/lib/types";
import type { ConversationMutation } from "@/lib/ahp/conversation-core";
import { canSendToChat } from "@/lib/ahp/chat-facts";
import { mergeConversationEvidence } from "@/lib/ahp/conversation-evidence";

const outcomes: Record<string, string> = {
  accepted: "The host accepted the new turn. This is not a completed answer.",
  queued: "Queued after the current turn.",
  "steering-pending": "Steering is pending. The host has not yet consumed it.",
  "consumed-or-removed": "The message is no longer pending. Consumption does not prove the instruction was followed.",
  cancelled: "The host removed the pending message.",
  reordered: "The host updated the queue order.",
};

export function UsageSummary({ usage, label }: { usage?: Partial<ChatUsage>; label: string }) {
  return (
    <p className="text-xs leading-5 text-muted-foreground tabular-nums">
      {label}: {usage ? <>
        input {usage.inputTokens?.toLocaleString() ?? "unavailable"} · output {usage.outputTokens?.toLocaleString() ?? "unavailable"}
        {usage.cacheReadTokens !== undefined && <> · cached input {usage.cacheReadTokens.toLocaleString()}</>}
        {!!usage.models?.length && <> · {usage.models.join(", ")}</>}
        {" · loaded-turn subtotal, not lifetime usage or context occupancy"}
        {usage.partial && " · partial receipts"}
        {usage.hasOlderTurns && " · older turns excluded"}
        {usage.observedAt && <> · observed {new Date(usage.observedAt).toLocaleTimeString()}</>}
      </> : "usage unavailable"}
    </p>
  );
}

type PendingEdit = ConversationDetails["pending"][number] & { draft: string };

function PendingMessages({ pending, busy, writable, uncertain, edit, onEdit, onText, onDiscard, onMutate }: {
  pending: ConversationDetails["pending"]; busy: boolean; writable: boolean; uncertain: boolean;
  edit?: PendingEdit;
  onEdit: (item: ConversationDetails["pending"][number]) => void; onText: (text: string) => void;
  onDiscard: () => void; onMutate: (mutation: ConversationMutation) => Promise<void>;
}) {
  if (!pending.length) return null;
  const queue = pending.filter((entry) => entry.kind === "queued");
  return <div className="space-y-2" aria-label="Pending messages">
    <h4 className="text-sm font-medium">Pending messages</h4>
    <p className="text-xs leading-5 text-muted-foreground">A running turn may consume a message before your edit or cancellation reaches the host.</p>
    {pending.map((item) => <div key={`${item.kind}:${item.id}`} className="border-t border-border/60 py-3">
      <p className="break-all text-xs text-muted-foreground">{item.kind === "steering" ? "Steering pending" : "Queued"} · {item.id}</p>
      {edit?.id === item.id && edit.kind === item.kind ? <>
        <Textarea aria-label="Edit pending message" value={edit.draft} onChange={(event) => onText(event.target.value)} className="mt-2 text-[13px]" />
        <Button variant="outline" size="sm" disabled={busy || !writable || uncertain || !edit.draft.trim()} onClick={() => void onMutate({ operation: "edit", kind: edit.kind, id: edit.id, expectedText: edit.text, message: edit.draft })}>Save pending message</Button>
        <Button variant="ghost" size="sm" onClick={onDiscard}>Discard edit</Button>
      </> : <p className="mt-1 whitespace-pre-wrap text-[13px] leading-5">{item.text}</p>}
      <div className="mt-2 flex flex-wrap gap-1">
        <Button variant="ghost" size="sm" disabled={busy || !writable || uncertain} onClick={() => onEdit(item)}>Edit</Button>
        <Button variant="ghost" size="sm" disabled={busy || !writable || uncertain} onClick={() => void onMutate({ operation: "cancel", kind: item.kind, id: item.id, expectedText: item.text })}>Cancel message</Button>
        {item.kind === "queued" && [true, false].map((up) => {
          const index = queue.findIndex((entry) => entry.id === item.id);
          const target = index + (up ? -1 : 1);
          return <Button key={String(up)} aria-label={`Move queued message ${up ? "up" : "down"}`} variant="ghost" size="icon-sm" disabled={busy || !writable || uncertain || target < 0 || target >= queue.length} onClick={() => {
            const order = queue.map((entry) => entry.id);
            [order[index], order[target]] = [order[target], order[index]];
            void onMutate({ operation: "reorder", order });
          }}>{up ? <ArrowUp className="size-3.5" /> : <ArrowDown className="size-3.5" />}</Button>;
        })}
      </div>
    </div>)}
  </div>;
}

export function ConversationControls({ card, hostUrl, onSent }: {
  card: KanbanCard; hostUrl: string | null; onSent: (text: string, outcome: string) => void;
}) {
  const [message, setMessage] = useState("");
  const [details, setDetails] = useState<ConversationDetails>();
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [uncertain, setUncertain] = useState(false);
  const [edit, setEdit] = useState<PendingEdit>();
  const [selection, setSelection] = useState<{ turnId: string; text: string }>();
  const request = useRef<AbortController | null>(null);
  const locked = useRef(false);
  useEffect(() => () => { request.current?.abort(); }, []);

  const chatUri = details?.chatUri ?? card.defaultChat;
  const catalog = card.chats?.filter((chat) => chat.interactivity !== "hidden") ?? [];
  const entry = card.chats?.find((chat) => chat.resource === chatUri);
  const hidden = entry?.interactivity === "hidden";
  const visible = !hidden && (!card.chats || !!entry);
  const writable = !!hostUrl && !card.isArchived && !card.ownershipConflict && card.automationWait?.reason !== "ownership"
    && visible && canSendToChat(entry) && (details?.writable ?? true);
  const livePending = chatUri ? card.chatDetails?.[chatUri]?.pendingMessages : undefined;
  const pending = visible ? livePending ?? details?.pending ?? [] : [];
  const running = entry?.status !== undefined ? (entry.status & 8) !== 0
    : details?.running ?? (card.runtime === "running" || card.runtime === "input-needed");
  const usage = chatUri && visible ? (expanded ? details?.usage : card.chatDetails?.[chatUri]?.usage) : undefined;

  async function perform(path: string, body: object, mutating: boolean) {
    if (locked.current || !hostUrl) return;
    locked.current = true;
    setBusy(true); setError(""); setNotice("");
    const controller = new AbortController();
    request.current = controller;
    try {
      const response = await fetch(path, {
        method: "POST", headers: { "Content-Type": "application/json" }, signal: controller.signal,
        body: JSON.stringify({ hostUrl, sessionUri: card.id, chatUri, ...body }),
      });
      const result = await response.json();
      if (!response.ok) {
        // A conflict can arrive after dispatch; only a fresh read clears uncertainty.
        throw new Error(result.error || "The host did not confirm this request.");
      }
      if (controller.signal.aborted) return;
      return result as { conversation?: ConversationDetails; outcome?: string; chatUri?: string };
    } catch (failure) {
      if (!controller.signal.aborted) {
        if (mutating) setUncertain(true);
        setError(failure instanceof Error ? failure.message : "Connection unavailable.");
      }
    } finally {
      locked.current = false;
      if (!controller.signal.aborted) setBusy(false);
    }
  }

  async function read(target = chatUri, history = false) {
    const result = await perform("/api/ahp/sessions/conversation", history
      ? { operation: "history", chatUri: target, cursor: details?.turnsNextCursor }
      : { operation: "read", chatUri: target }, false);
    if (result?.conversation) {
      const page = result.conversation;
      if (page.chatUri !== chatUri) { setMessage(""); setEdit(undefined); setSelection(undefined); }
      setDetails((previous) => history ? mergeConversationEvidence(previous, page) : page);
      setExpanded(true); setUncertain(false);
    }
  }

  async function mutate(mutation: ConversationMutation) {
    if (!writable || uncertain) return;
    if ((mutation.operation === "send" || mutation.operation === "steer") && !mutation.message.trim()) return;
    const result = await perform("/api/ahp/sessions/message", mutation, true);
    if (!result?.conversation) return;
    setDetails(result.conversation);
    setNotice(outcomes[result.outcome ?? ""] ?? "The host confirmed the change.");
    setEdit(undefined);
    if (mutation.operation === "send" || mutation.operation === "steer") {
      setMessage(""); onSent(mutation.message, result.outcome ?? "accepted");
    }
  }

  async function create(kind?: "fork" | "sideChat", turnId?: string, selectedText?: string) {
    if (!writable || uncertain || !chatUri) return;
    const result = await perform("/api/ahp/sessions/conversation", {
      operation: "create",
      ...(kind && turnId ? { source: {
        kind, chat: chatUri, turnId,
        ...(kind === "sideChat" && selectedText ? { selection: { text: selectedText } } : {}),
      } } : {}),
    }, true);
    if (result?.chatUri) {
      setSelection(undefined);
      await read(result.chatUri);
      setNotice(`Conversation created: ${result.chatUri}. If loading failed, choose it from the catalog rather than creating another copy.`);
    }
  }

  return (
    <section className="space-y-3 pt-2" aria-label="Conversation controls">
      {(usage || expanded) && <UsageSummary usage={usage} label={chatUri === card.defaultChat ? "Lead chat" : "Conversation"} />}
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" disabled={busy || !hostUrl || card.ownershipConflict} onClick={() => void read()}>
          {busy ? <Loader2 className="size-3.5 animate-spin" /> : null}
          {expanded ? "Reload conversation" : "Inspect conversation"}
        </Button>
        {expanded && (catalog.length > 1 || (!entry && catalog.length > 0)) && <label className="text-xs">
          <span className="sr-only">Conversation</span>
          <select className="max-w-56 rounded-md border border-border bg-background p-1.5 text-xs" value={chatUri} disabled={busy} onChange={(event) => void read(event.target.value)}>
            {catalog.map((chat) => <option key={chat.resource} value={chat.resource}>{chat.title || chat.resource}{chat.interactivity === "read-only" ? " (read-only)" : ""}</option>)}
            {!entry && <option value={chatUri} disabled>Conversation unavailable in catalog</option>}
          </select>
        </label>}
        {expanded && details?.capabilities.ordinary && writable && <Button variant="ghost" size="sm" disabled={busy || uncertain} onClick={() => void create()}>New conversation</Button>}
      </div>
      {expanded && !visible && <p role="status" className="text-xs text-muted-foreground">Waiting for a visible conversation in the host catalog. Reload or choose another conversation.</p>}
      {expanded && details && visible && <div className="space-y-3">
        <p className="break-all text-xs text-muted-foreground">Chat: {details.chatUri}</p>
        {details.origin?.chat && <p className="break-all text-xs text-muted-foreground">
          {details.origin.kind} from {details.origin.chat} · turn {details.origin.turnId ?? "unavailable"}
          {details.origin.selection && <> · selected snapshot: {details.origin.selection.text}</>}
        </p>}
        {!details.turns.length && <p className="text-xs text-muted-foreground">No conversation turns are available.</p>}
        {details.historyTruncated && <p className="text-xs text-muted-foreground">Only bounded excerpts are shown; some turns are omitted.</p>}
        {details.turnsNextCursor && <p className="text-xs text-muted-foreground">Partial history: older turns have not been loaded.</p>}
        {details.turns.map((turn) => <details key={turn.turnId} className="border-t border-border/60 py-3">
          <summary className="cursor-pointer break-words text-xs leading-5">{turn.prompt || "Agent outcome"} · {turn.state}</summary>
          <p className="mt-2 break-all text-xs text-muted-foreground">Turn: {turn.turnId}</p>
          <p className="mt-2 whitespace-pre-wrap text-[13px] leading-relaxed">{turn.text || "Response content unavailable."}</p>
          {turn.truncated && <p className="mt-1 text-xs text-muted-foreground">Bounded excerpt; some content is omitted.</p>}
          <div className="mt-2 flex flex-wrap gap-2">
            {details.capabilities.sideChat && writable && <Button variant="outline" size="sm" disabled={busy || uncertain} onClick={() => void create("sideChat", turn.turnId)}>Discuss this turn</Button>}
            {details.capabilities.sideChat && writable && <Button variant="ghost" size="sm" disabled={busy || uncertain} onClick={() => setSelection({ turnId: turn.turnId, text: "" })}>Discuss an excerpt</Button>}
            {details.capabilities.fork && writable && turn.state === "complete" && <Button variant="outline" size="sm" disabled={busy || uncertain} onClick={() => void create("fork", turn.turnId)}>Branch from this turn</Button>}
          </div>
          {selection?.turnId === turn.turnId && <div className="mt-2 space-y-2">
            <Textarea aria-label="Selected-text snapshot" placeholder="Paste the excerpt to discuss…" value={selection.text} maxLength={8_000}
              onChange={(event) => setSelection({ turnId: turn.turnId, text: event.target.value })} className="text-[13px]" />
            <p className="text-xs text-muted-foreground">Saved as an exact snapshot; later changes to the source do not change it.</p>
            <Button variant="outline" size="sm" disabled={busy || uncertain || !writable || !selection.text.trim()} onClick={() => void create("sideChat", turn.turnId, selection.text)}>Discuss snapshot</Button>
            <Button variant="ghost" size="sm" onClick={() => setSelection(undefined)}>Cancel</Button>
          </div>}
        </details>)}
        {details.turnsNextCursor ? <Button variant="outline" size="sm" disabled={busy} onClick={() => void read(chatUri, true)}>Load older turns</Button>
          : <p className="text-xs text-muted-foreground">No older history is available from the host.</p>}
      </div>}
      <PendingMessages pending={pending} busy={busy} writable={writable} uncertain={uncertain}
        edit={edit} onEdit={(item) => setEdit({ ...item, draft: item.text })}
        onText={(draft) => setEdit((previous) => previous && { ...previous, draft })} onDiscard={() => setEdit(undefined)} onMutate={mutate} />
      {edit && !pending.some((item) => item.id === edit.id && item.kind === edit.kind) && <p className="text-xs text-muted-foreground">The edited message was consumed or removed and can no longer be changed.</p>}
      <form onSubmit={(event) => { event.preventDefault(); void mutate({ operation: "send", message }); }} className="space-y-2">
        <Textarea aria-label="Instructions for this conversation" value={message} onChange={(event) => setMessage(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault(); void mutate({ operation: "send", message });
          } }}
          disabled={!writable || busy || uncertain} placeholder={writable ? "Send instructions to this conversation…" : "This conversation is unavailable or read-only"}
          rows={2} className="min-h-[3rem] resize-none text-[13px]" />
        <div className="flex flex-wrap gap-2">
          <Button type="submit" variant="outline" size="sm" disabled={!writable || busy || uncertain || !message.trim()}><Send className="size-3.5" />{running ? "Queue message" : "Send message"}</Button>
          {running && writable && <Button type="button" variant="ghost" size="sm" disabled={busy || uncertain || !message.trim()} onClick={() => void mutate({ operation: "steer", message })}>Steer now</Button>}
        </div>
      </form>
      {notice && <p role="status" className="break-words text-xs leading-5 text-muted-foreground">{notice}</p>}
      {error && <p role="alert" className="text-xs leading-5 text-destructive">{error}</p>}
      {uncertain && <p className="text-xs leading-5 text-muted-foreground">The change is unconfirmed. Reload and inspect the conversation before another change.</p>}
    </section>
  );
}
