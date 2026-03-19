import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/")({ component: LandingPage });

const features = [
  {
    title: "Parallel Execution",
    description:
      "Spawn multiple workers at once. Codex handles backend, Opus handles UI\u2009\u2014\u2009all running simultaneously in isolated git worktrees.",
  },
  {
    title: "Agentic Merge Queue",
    description:
      "A dedicated merger agent serializes all completed work into main. One integration point, no conflicts, no babysitting.",
  },
  {
    title: "Persistent Memory",
    description:
      "Your manager remembers preferences, routing decisions, and project context across sessions. The knowledge compounds over time.",
  },
  {
    title: "Event-Driven Manager",
    description:
      "The manager is never blocked. It dispatches work, handles status updates, and steers agents\u2009\u2014\u2009all without waiting on any single worker.",
  },
  {
    title: "Multi-Model Teams",
    description:
      "Route tasks to the right model. Codex\u00a0App for backend features, Opus for UI polish, Codex for code generation. Your manager picks.",
  },
  {
    title: "Local-First &\u00a0Open\u00a0Source",
    description:
      "Self-hosted daemon on your machine. Apache\u00a02.0 licensed. Your code and API keys never leave localhost.",
  },
];

const flow = [
  {
    step: 1,
    title: "Create a manager",
    description:
      "Spin one up for your project. Point it at a repo, pick the models you want it to use, and you\u2019re ready to go.",
  },
  {
    step: 2,
    title: "Onboard it",
    description:
      "Tell it how you like to work\u2009\u2014\u2009how tasks should be broken down, which models handle what, your coding standards and preferences. It remembers everything.",
  },
  {
    step: 3,
    title: "Let it manage",
    description:
      "Hand off the work. Your manager dispatches coding agents, tracks progress, handles merges, and keeps you posted. You direct\u2009\u2014\u2009it executes.",
  },
];

const quickStartCommands = [
  "git clone https://github.com/SawyerHood/middleman.git",
  "cd middleman",
  "pnpm install",
  "pnpm dev",
];

function LandingPage() {
  return (
    <div className="min-h-screen bg-page text-ink">
      <div className="mx-auto max-w-[68rem] px-6 sm:px-10 lg:px-16">
        {/* ── Nav ── */}
        <nav className="reveal flex items-center justify-between py-7" aria-label="Primary">
          <a
            href="/"
            className="font-display text-[1.15rem] tracking-[-0.01em] no-underline"
            aria-label="Middleman home"
          >
            Middleman
          </a>
          <a
            href="https://github.com/SawyerHood/middleman"
            target="_blank"
            rel="noopener noreferrer"
            className="text-[13px] text-muted no-underline transition-colors duration-200 hover:text-ink"
          >
            GitHub
          </a>
        </nav>

        <main id="main">
          {/* ── Hero ── */}
          <section className="pb-20 pt-24 sm:pt-32 lg:pt-40" aria-labelledby="hero-heading">
            <h1
              id="hero-heading"
              className="reveal-1 font-display max-w-[52rem] text-[clamp(2.4rem,5.6vw,4.2rem)] font-normal italic leading-[1.1] tracking-[-0.025em]"
            >
              Stop managing your agents.{" "}
              <span className="text-muted">Hire a middle&nbsp;manager.</span>
            </h1>

            <p className="reveal-2 mt-8 max-w-xl text-[1.05rem] leading-[1.7] text-muted text-pretty">
              Go from being the agent manager to the CEO of your coding projects. Stop dispatching
              tasks, babysitting terminals, and rebasing branches. Give direction, set standards,
              and let a persistent AI manager handle everything between your intent and shipped
              code.
            </p>

            <div className="reveal-3 mt-10 flex items-center gap-8">
              <a
                href="#quick-start"
                className="text-[13px] font-medium underline decoration-accent decoration-[1.5px] underline-offset-[5px] transition-colors duration-200 hover:text-accent"
              >
                Get Started
              </a>
              <a
                href="https://github.com/SawyerHood/middleman"
                target="_blank"
                rel="noopener noreferrer"
                className="text-[13px] text-muted no-underline transition-colors duration-200 hover:text-ink"
              >
                View Source &rarr;
              </a>
            </div>
          </section>

          <Rule />

          {/* ── At a glance ── */}
          <section className="py-12" aria-labelledby="glance-heading">
            <h2 id="glance-heading" className="sr-only">
              At a Glance
            </h2>
            <dl className="grid grid-cols-1 gap-y-6 sm:grid-cols-3 sm:gap-y-7">
              {(
                [
                  ["Runtimes", "Claude, Codex, Codex\u00a0App"],
                  ["Channels", "Web"],
                  ["License", "Apache\u00a02.0"],
                ] as const
              ).map(([label, value]) => (
                <div key={label}>
                  <dt className="text-[11px] font-medium tracking-[0.14em] text-muted uppercase">
                    {label}
                  </dt>
                  <dd className="mt-2 text-[13px]">{value}</dd>
                </div>
              ))}
            </dl>
          </section>

          <Rule />

          {/* ── The pitch ── */}
          <section className="py-20 sm:py-24" aria-labelledby="problem-heading">
            <h2
              id="problem-heading"
              className="text-[11px] font-medium tracking-[0.14em] text-muted uppercase"
            >
              The Problem
            </h2>

            <div className="mt-8 max-w-2xl space-y-5">
              <p className="text-[1.05rem] leading-[1.7] text-muted text-pretty">
                AI agents are good at focused work&thinsp;&mdash;&thinsp;writing code, fixing bugs,
                refactoring modules. But someone still has to play project manager. You&rsquo;re the
                one creating branches, assigning tasks, watching terminals, merging PRs, and
                context-switching between five different agent sessions.
              </p>
              <p className="text-[1.05rem] leading-[1.7] text-ink text-pretty">
                Middleman gives every project a persistent manager that actually sticks around. You
                tell it what needs to get done&thinsp;&mdash;&thinsp;it dispatches workers, tracks
                progress, and handles the merge queue. You stay informed, not involved.
              </p>
            </div>
          </section>

          <Rule />

          {/* ── How it works ── */}
          <section className="py-20 sm:py-24" aria-labelledby="how-heading">
            <h2
              id="how-heading"
              className="text-[11px] font-medium tracking-[0.14em] text-muted uppercase"
            >
              How It Works
            </h2>

            <ol className="mt-12 grid gap-10 sm:grid-cols-3 sm:gap-x-16 list-none p-0">
              {flow.map((step) => (
                <li key={step.title}>
                  <p
                    className="text-[11px] font-medium tracking-[0.14em] text-muted/50 uppercase"
                    aria-hidden="true"
                  >
                    Step&nbsp;{step.step}
                  </p>
                  <h3 className="mt-1.5 text-[15px] font-medium">{step.title}</h3>
                  <p className="mt-2 text-[13px] leading-[1.7] text-muted">{step.description}</p>
                </li>
              ))}
            </ol>
          </section>

          <Rule />

          {/* ── Features ── */}
          <section className="py-20 sm:py-24" aria-labelledby="capabilities-heading">
            <h2
              id="capabilities-heading"
              className="text-[11px] font-medium tracking-[0.14em] text-muted uppercase"
            >
              Capabilities
            </h2>

            <div className="mt-12 grid gap-x-20 sm:grid-cols-2">
              {features.map((feature) => (
                <article key={feature.title} className="border-t border-rule py-6">
                  <h3 className="text-[14px] font-medium leading-snug">{feature.title}</h3>
                  <p className="mt-1.5 text-[13px] leading-[1.7] text-muted">
                    {feature.description}
                  </p>
                </article>
              ))}
            </div>
          </section>

          <Rule />

          {/* ── Quick start ── */}
          <section id="quick-start" className="py-20 sm:py-24" aria-labelledby="quickstart-heading">
            <h2
              id="quickstart-heading"
              className="text-[11px] font-medium tracking-[0.14em] text-muted uppercase"
            >
              Quick Start
            </h2>

            <div
              className="mt-12 overflow-hidden rounded-xl bg-ink"
              role="region"
              aria-label="Quick start terminal commands"
            >
              <pre className="overflow-x-auto p-6 text-[13px] leading-[1.9] text-page/70">
                <code>{quickStartCommands.map((c) => `$ ${c}`).join("\n")}</code>
              </pre>
            </div>
            <p className="mt-5 text-[13px] text-muted">
              Opens at <span className="text-ink font-medium">localhost:47188</span>. Create a
              manager, point it at a repo, and start delegating. All data stays local.
            </p>
          </section>
        </main>

        <Rule />

        {/* ── Footer ── */}
        <footer className="flex flex-wrap items-center justify-between gap-4 py-8 text-[12px] text-muted">
          <span>Middleman&thinsp;&mdash;&thinsp;The middle manager your agents deserve</span>
          <nav aria-label="Footer">
            <ul className="flex gap-6 list-none m-0 p-0">
              {(
                [
                  ["GitHub", "https://github.com/SawyerHood/middleman"],
                  ["License", "https://github.com/SawyerHood/middleman/blob/main/LICENSE"],
                ] as const
              ).map(([label, href]) => (
                <li key={label}>
                  <a
                    href={href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="no-underline transition-colors duration-200 hover:text-ink"
                  >
                    {label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        </footer>
      </div>
    </div>
  );
}

function Rule() {
  return <hr className="border-rule" aria-hidden="true" />;
}
