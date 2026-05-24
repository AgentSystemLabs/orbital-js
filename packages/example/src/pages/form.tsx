import type { Station } from "@orbital-js/station";
import type { AppCtx } from "../index";

type Submission = { name: string; email: string; age: number; ts: number };

const MAX = 20;
const submissions: Submission[] = [];

export function registerForm(station: Station<AppCtx>) {
  station.template("form", () => {
    return (
      <div class="py-12 space-y-6">
        <h1 class="text-2xl font-bold">Form Validation</h1>
        <p class="opacity-70">
          Validation runs on submit. Once a field has an error, typing into it
          re-validates and clears the error as soon as the value becomes valid.
        </p>

        <form
          p-action="form:submit"
          data-validate
          novalidate
          class="space-y-4 max-w-md"
        >
          <div>
            <label class="block mb-1" for="form-name">
              Name
            </label>
            <input
              id="form-name"
              name="name"
              type="text"
              data-rules="required|minLength:2"
              class="input input-bordered w-full"
              placeholder="Your name"
            />
            <p
              data-error-for="name"
              class="text-error text-sm mt-1 min-h-[1.25rem]"
            ></p>
          </div>

          <div>
            <label class="block mb-1" for="form-email">
              Email
            </label>
            <input
              id="form-email"
              name="email"
              type="text"
              data-rules="required|email"
              class="input input-bordered w-full"
              placeholder="you@example.com"
            />
            <p
              data-error-for="email"
              class="text-error text-sm mt-1 min-h-[1.25rem]"
            ></p>
          </div>

          <div>
            <label class="block mb-1" for="form-age">
              Age
            </label>
            <input
              id="form-age"
              name="age"
              type="text"
              data-rules="required|integer|min:18"
              class="input input-bordered w-full"
              placeholder="18 or older"
            />
            <p
              data-error-for="age"
              class="text-error text-sm mt-1 min-h-[1.25rem]"
            ></p>
          </div>

          <button class="btn btn-primary">Submit</button>
        </form>

        <div p-template="form:submissions"></div>
      </div>
    );
  });

  station.template("form:submissions", () => {
    if (submissions.length === 0) {
      return <div class="opacity-60">No submissions yet.</div>;
    }
    return (
      <div class="space-y-2">
        <h2 class="text-lg font-bold">Recent submissions</h2>
        <ul class="space-y-2">
          {submissions
            .slice()
            .reverse()
            .map((s) => (
              <li class="card bg-base-200 p-3">
                <div>
                  <span class="font-bold">{s.name}</span>{" "}
                  <span class="opacity-70">&lt;{s.email}&gt;</span>{" "}
                  <span class="opacity-70">— age {s.age}</span>
                </div>
              </li>
            ))}
        </ul>
      </div>
    );
  });

  station.action("form:submit", async ({ broadcast, data }) => {
    const d = (data ?? {}) as Record<string, unknown>;
    const name = String(d.name ?? "").trim();
    const email = String(d.email ?? "").trim();
    const age = Number(d.age);
    if (!name || name.length < 2) return;
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return;
    if (!Number.isInteger(age) || age < 18) return;

    submissions.push({ name, email, age, ts: Date.now() });
    if (submissions.length > MAX) {
      submissions.splice(0, submissions.length - MAX);
    }
    broadcast("form:submissions");
  });
}
