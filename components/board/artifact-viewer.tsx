"use client";

import { useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  FileText,
  FlaskConical,
  Lightbulb,
  BookOpen,
  ClipboardCheck,
  Scale,
  Bot,
  User,
} from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Artifact, ArtifactType, ArtifactStatus } from "@/lib/types";

interface ArtifactViewerProps {
  artifact: Artifact | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const artifactIcons: Record<ArtifactType, typeof FileText> = {
  plan: FileText,
  review: ClipboardCheck,
  research: FlaskConical,
  design: Lightbulb,
  spec: BookOpen,
  "test-plan": ClipboardCheck,
  decision: Scale,
};

const artifactTypeLabels: Record<ArtifactType, string> = {
  plan: "Plan",
  review: "Review",
  research: "Research",
  design: "Design",
  spec: "Specification",
  "test-plan": "Test Plan",
  decision: "Decision",
};

const statusVariant: Record<ArtifactStatus, "default" | "secondary" | "outline"> = {
  draft: "outline",
  approved: "default",
  superseded: "secondary",
};

function formatDate(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function ArtifactViewer({ artifact, open, onOpenChange }: ArtifactViewerProps) {
  const components = useMemo(
    () => ({
      a: ({ href, children, ...props }: React.ComponentProps<"a">) => (
        <a href={href} target="_blank" rel="noreferrer" {...props}>
          {children}
        </a>
      ),
      pre: ({ children, ...props }: React.ComponentProps<"pre">) => (
        <pre className="overflow-x-auto" {...props}>
          {children}
        </pre>
      ),
      table: ({ children, ...props }: React.ComponentProps<"table">) => (
        <div className="overflow-x-auto">
          <table {...props}>{children}</table>
        </div>
      ),
    }),
    []
  );

  if (!artifact) return null;

  const Icon = artifactIcons[artifact.type];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl max-h-[80vh] grid-rows-[auto_1fr] gap-0 p-0 overflow-hidden">
        <DialogHeader className="px-6 pt-5 pb-3 border-b border-border shrink-0">
          <div className="flex items-center gap-2">
            <Icon className="h-4 w-4 text-muted-foreground shrink-0" />
            <DialogTitle className="text-base">{artifact.title}</DialogTitle>
          </div>
          <DialogDescription>
            <span className="flex items-center gap-2 text-xs text-muted-foreground">
              <Badge variant={statusVariant[artifact.status]} className="h-5 text-[10px] capitalize">
                {artifact.status}
              </Badge>
              <span className="text-muted-foreground/50">·</span>
              <span>{artifactTypeLabels[artifact.type]}</span>
              <span className="text-muted-foreground/50">·</span>
              <span className="inline-flex items-center gap-1">
                {artifact.createdBy === "agent" ? (
                  <Bot className="h-3 w-3" />
                ) : (
                  <User className="h-3 w-3" />
                )}
                {artifact.createdBy === "agent" ? "Agent" : "Human"}
              </span>
              <span className="text-muted-foreground/50">·</span>
              <span>{formatDate(artifact.createdAt)}</span>
            </span>
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="min-h-0">
          <div className="px-6 py-5">
            {artifact.contentRef ? (
              <article className="prose dark:prose-invert max-w-none prose-headings:font-heading prose-h1:text-xl prose-h1:mb-4 prose-h2:text-base prose-h2:mt-6 prose-h2:mb-2 prose-h3:text-sm prose-p:text-sm prose-p:leading-relaxed prose-li:text-sm prose-table:text-xs prose-pre:bg-muted prose-pre:border prose-pre:border-border prose-code:text-[13px] prose-strong:font-semibold">
                <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
                  {artifact.contentRef}
                </ReactMarkdown>
              </article>
            ) : (
              <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                <Icon className="h-8 w-8 mb-2 opacity-30" />
                <p className="text-sm">No content available yet</p>
                <p className="text-xs mt-1 opacity-60">
                  Content will appear here once the artifact is populated
                </p>
              </div>
            )}
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
