import { Parabola } from "@parabolajs/parabola";
import { serveStatic } from "hono/bun";
import { registerMain } from "./pages/main";
import { registerPoll } from "./pages/poll";
import { registerCounter } from "./pages/counter";
import { registerViews } from "./pages/views";
import { registerChat } from "./pages/chat";
import { registerGrid } from "./pages/grid";
import { registerArticles } from "./pages/articles";
import { registerNotes } from "./pages/notes";
import { registerForm } from "./pages/form";
import { REDIS_URL } from "./redis";

export type AppCtx = {
  count: number;
  articleFilter: string;
};

export const parabola = new Parabola<AppCtx>({
  styles: ["/styles.css"],
  port: Number(process.env.PORT ?? 3000),
  redis: { url: REDIS_URL },
  routes: [
    { path: "/", target: "content", template: "welcome" },
    { path: "/poll", target: "content", template: "poll" },
    { path: "/views", target: "content", template: "views" },
    { path: "/counter", target: "content", template: "counter" },
    { path: "/chat", target: "content", template: "chat" },
    { path: "/grid", target: "content", template: "grid" },
    { path: "/articles", target: "content", template: "articles" },
    { path: "/notes", target: "content", template: "notes" },
    { path: "/form", target: "content", template: "form" },
  ],
});

parabola.onConnect(() => ({
  count: 0,
  articleFilter: "",
}));

registerMain(parabola);
registerPoll(parabola);
registerCounter(parabola);
registerViews(parabola);
registerChat(parabola);
registerGrid(parabola);
registerArticles(parabola);
registerNotes(parabola);
registerForm(parabola);

// Mount the styles route after templates/actions are registered so any
// beforeUpgrade hook gets a chance to wire in first.
parabola
  .getApp()
  .use("/styles.css", serveStatic({ path: "./dist/styles.css" }));

await parabola.listen();
