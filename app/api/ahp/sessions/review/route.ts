import { NextRequest, NextResponse } from "next/server";
import type { Changeset } from "@microsoft/agent-host-protocol";

import { ahpErrorResponse } from "@/lib/ahp/api-error";
import {
  changesetFilesReviewChanged,
  changesetReviewSummary,
  changesetSupportsReview,
  isChangesetFileReviewed,
  isStaticChangesetUri,
} from "@/lib/ahp/changeset-review";
import { findSessionChangeset } from "@/lib/ahp/changeset-enricher";
import { readReadyChangesetState } from "@/lib/ahp/changeset-readiness";
import { readSessionState } from "@/lib/ahp/snapshot";
import { withAHPClient } from "@/lib/ahp/client-operation";
import { validateLocalMutationRequest } from "@/lib/http/local-mutation";

const debug = (...args: unknown[]) => {
  if (process.env.AHP_DEBUG) console.info("[ahp:review]", ...args);
};

function reviewResponse(changeset: Changeset, files: Parameters<typeof changesetReviewSummary>[1]) {
  return { review: changesetReviewSummary(changeset, files) };
}

/**
 * Mark selected AHP changeset files reviewed/unreviewed.
 *
 * The browser provides only opaque file IDs and the desired bit. The selected
 * changeset channel, capability, ready state, and current IDs are always read
 * again from the host, so stale cards cannot mutate a different changeset.
 */
export async function POST(request: NextRequest) {
  const requestError = validateLocalMutationRequest(request);
  if (requestError) {
    return NextResponse.json({ error: requestError }, { status: 403 });
  }

  const body = (await request.json()) as {
    hostUrl?: unknown;
    sessionUri?: unknown;
    files?: unknown;
    reviewed?: unknown;
  };

  const hostUrl = typeof body.hostUrl === "string" ? body.hostUrl : "";
  const sessionUri = typeof body.sessionUri === "string" ? body.sessionUri : "";
  const files = Array.isArray(body.files) ? body.files : [];
  const reviewed = body.reviewed;

  if (
    !hostUrl ||
    !sessionUri ||
    files.length === 0 ||
    files.some((file) => typeof file !== "string" || file.length === 0) ||
    new Set(files).size !== files.length ||
    typeof reviewed !== "boolean"
  ) {
    return NextResponse.json(
      { error: "hostUrl, sessionUri, unique files, and reviewed are required" },
      { status: 400 },
    );
  }

  const fileIds = files as string[];

  try {
    return await withAHPClient(hostUrl, async (client) => {
      const session = await readSessionState(client, sessionUri);
      const changeset = session?.changesets ? findSessionChangeset(session.changesets) : undefined;

      if (!changeset || !isStaticChangesetUri(changeset.uriTemplate)) {
        return NextResponse.json(
          { error: "No static session changeset is available", stale: true },
          { status: 409 },
        );
      }

      if (!changesetSupportsReview(changeset)) {
        return NextResponse.json(
          { error: "Changeset does not support file review", stale: true },
          { status: 409 },
        );
      }

      const before = await readReadyChangesetState(client, changeset.uriTemplate);
      if (!before) {
        return NextResponse.json(
          {
            error: "Changeset is not ready",
            stale: true,
          },
          { status: 409 },
        );
      }

      const currentIds = new Set(before.files.map((file) => file.id));
      if (fileIds.some((fileId) => !currentIds.has(fileId))) {
        debug("review request contains stale file IDs:", sessionUri);
        return NextResponse.json(
          { error: "One or more files changed", stale: true, ...reviewResponse(changeset, before.files) },
          { status: 409 },
        );
      }

      if (fileIds.every((fileId) => {
        const file = before.files.find((candidate) => candidate.id === fileId);
        return file !== undefined && isChangesetFileReviewed(file) === reviewed;
      })) {
        return NextResponse.json({ ok: true, noop: true, ...reviewResponse(changeset, before.files) });
      }

      client.dispatch(
        changeset.uriTemplate,
        changesetFilesReviewChanged(fileIds, reviewed),
      );

      // Let the host echo its authoritative state, then reconcile rather than
      // trusting the optimistic client write-ahead state.
      await new Promise((resolve) => setTimeout(resolve, 300));
      const afterSession = await readSessionState(client, sessionUri);
      const authoritativeChangeset = afterSession?.changesets
        ? findSessionChangeset(afterSession.changesets)
        : undefined;
      if (
        !authoritativeChangeset ||
        !isStaticChangesetUri(authoritativeChangeset.uriTemplate) ||
        authoritativeChangeset.uriTemplate !== changeset.uriTemplate
      ) {
        return NextResponse.json(
          { error: "Changeset changed while updating review state", stale: true },
          { status: 409 },
        );
      }

      const after = await readReadyChangesetState(client, authoritativeChangeset.uriTemplate);
      if (!after) {
        return NextResponse.json(
          {
            error: "Changeset changed while updating review state",
            stale: true,
          },
          { status: 409 },
        );
      }

      const afterById = new Map(after.files.map((file) => [file.id, file]));
      const applied = fileIds.every(
        (fileId) => {
          const file = afterById.get(fileId);
          return file !== undefined && isChangesetFileReviewed(file) === reviewed;
        },
      );
      if (!applied) {
        return NextResponse.json(
          {
            error: "Review update was not applied",
            stale: true,
            ...reviewResponse(authoritativeChangeset, after.files),
          },
          { status: 409 },
        );
      }

      return NextResponse.json({ ok: true, ...reviewResponse(authoritativeChangeset, after.files) });
    });
  } catch (err) {
    console.error("[ahp:review] error:", err instanceof Error ? err.message : err);
    return ahpErrorResponse(err, "Failed to update file review state");
  }
}
