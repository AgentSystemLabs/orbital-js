import type { Parabola } from "@parabolajs/parabola";
import type { AppCtx } from "../index";

const articles = [
  {
    id: 1,
    title: "ParabolaJs: a small reactive framework",
    body: "Server-rendered templates over WebSockets, no virtual DOM.",
  },
  {
    id: 2,
    title: "WebSockets with Bun and Hono",
    body: "Bun's built-in WebSocket adapter plus Hono routing.",
  },
  {
    id: 3,
    title: "Server-side rendering on a budget",
    body: "Recursive HTMLRewriter passes inline every p-template slot.",
  },
  {
    id: 4,
    title: "Per-connection context, explained",
    body: "Each socket gets its own ctx object you mutate from actions.",
  },
  {
    id: 5,
    title: "Hydration without a virtual DOM",
    body: "Mark SSR'd nodes with data-p-hydrated; client subscribes without re-fetching.",
  },
];

export function registerArticles(parabola: Parabola<AppCtx>) {
  parabola.template("articles", ({ ctx }) => {
    const filter = (ctx.articleFilter ?? "").toLowerCase();
    const visible = filter
      ? articles.filter((a) => a.title.toLowerCase().includes(filter))
      : articles;
    return (
      <div class="py-12 space-y-6">
        <h1 class="text-2xl font-bold">Articles</h1>

        <p class="opacity-70">
          The list below is server-rendered into the initial HTTP response. View
          page source to confirm — every title is in the markup before any JS
          runs. The filter is per-connection.
        </p>

        <form p-action="articles:filter" class="flex gap-2">
          <input
            name="q"
            type="text"
            value={ctx.articleFilter ?? ""}
            placeholder="Filter by title..."
            class="input input-bordered flex-1"
          />
          <button class="btn btn-primary">Filter</button>
          <button p-action="articles:clear" formaction="" class="btn">
            Clear
          </button>
        </form>

        <ul class="space-y-3">
          {visible.map((a) => (
            <li class="card bg-base-200 p-4">
              <strong class="text-lg">{a.title}</strong>
              <p class="opacity-80">{a.body}</p>
            </li>
          ))}
        </ul>

        {visible.length === 0 ? (
          <div class="opacity-60">No articles match that filter.</div>
        ) : null}

        <div class="text-sm opacity-60">
          Showing {visible.length} of {articles.length}
          {filter ? ` · filter: "${ctx.articleFilter}"` : ""}
        </div>
      </div>
    );
  });

  parabola.action("articles:filter", ({ ctx, invalidate, data }) => {
    ctx.articleFilter = (data?.q ?? "").toString();
    invalidate("articles");
  });

  parabola.action("articles:clear", ({ ctx, invalidate }) => {
    ctx.articleFilter = "";
    invalidate("articles");
  });
}
