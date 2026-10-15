import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";

// Model output is GitHub-flavored Markdown. Raw HTML in it stays escaped
// text (no rehype-raw), so a reply can never inject markup into Studio.
const components: Components = {
  h1: ({ node: _, ...props }) => (
    <h1 className="mt-4 mb-2 text-xl font-semibold first:mt-0" {...props} />
  ),
  h2: ({ node: _, ...props }) => (
    <h2 className="mt-4 mb-2 text-lg font-semibold first:mt-0" {...props} />
  ),
  h3: ({ node: _, ...props }) => (
    <h3 className="mt-3 mb-1.5 text-base font-semibold first:mt-0" {...props} />
  ),
  h4: ({ node: _, ...props }) => (
    <h4 className="mt-3 mb-1 font-semibold first:mt-0" {...props} />
  ),
  p: ({ node: _, ...props }) => (
    <p className="my-2 first:mt-0 last:mb-0" {...props} />
  ),
  ul: ({ node: _, ...props }) => (
    <ul className="my-2 list-disc space-y-1 pl-6" {...props} />
  ),
  ol: ({ node: _, ...props }) => (
    <ol className="my-2 list-decimal space-y-1 pl-6" {...props} />
  ),
  a: ({ node: _, ...props }) => (
    <a
      className="text-primary underline underline-offset-2 hover:opacity-80"
      target="_blank"
      rel="noopener noreferrer"
      {...props}
    />
  ),
  blockquote: ({ node: _, ...props }) => (
    <blockquote
      className="my-2 border-l-2 pl-3 text-muted-foreground"
      {...props}
    />
  ),
  hr: ({ node: _, ...props }) => <hr className="my-4" {...props} />,
  pre: ({ node: _, ...props }) => (
    <pre
      className="my-2 overflow-x-auto rounded-md bg-muted p-3 font-mono text-xs [&>code]:bg-transparent [&>code]:p-0"
      {...props}
    />
  ),
  code: ({ node: _, className, ...props }) => (
    <code
      className={cn(
        "rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]",
        className,
      )}
      {...props}
    />
  ),
  table: ({ node: _, ...props }) => (
    <div className="my-3 overflow-x-auto">
      <table className="w-full border-collapse text-sm" {...props} />
    </div>
  ),
  th: ({ node: _, ...props }) => (
    <th
      className="border bg-muted px-2 py-1 text-left font-medium"
      {...props}
    />
  ),
  td: ({ node: _, ...props }) => (
    <td className="border px-2 py-1 align-top" {...props} />
  ),
};

export function Markdown({
  children,
  className,
}: {
  children: string;
  className?: string;
}) {
  return (
    <div className={cn("break-words", className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {children}
      </ReactMarkdown>
    </div>
  );
}
