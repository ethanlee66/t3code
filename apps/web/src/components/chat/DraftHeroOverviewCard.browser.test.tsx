import {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  UsageDay,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { render } from "../../../test/render";

const state = vi.hoisted(() => ({
  projects: [] as Array<{
    readonly environmentId: EnvironmentId;
    readonly id: ProjectId;
    readonly title: string;
    readonly workspaceRoot: string;
    readonly defaultModelSelection: null;
    readonly scripts: readonly [];
    readonly createdAt: string;
    readonly updatedAt: string;
  }>,
  presentations: new Map(),
  calls: [] as Array<{ range: string; projectIds: readonly string[] | null }>,
  merged: {
    sessions: 8,
    messages: 182,
    activeDays: 4,
    inputTokens: 28_000_000,
    cachedInputTokens: 26_656_000,
    cacheCreationTokens: 0,
    cacheEligibleInputTokens: 28_000_000,
    cacheHitRate: 0.952,
    outputTokens: 1_000_000,
    reasoningTokens: 0,
    otherInputTokens: 0,
    otherOutputTokens: 0,
    totalTokens: 29_000_000,
    models: [
      {
        driver: "antigravity",
        model: "gemini-4-neon",
        inputTokens: 28_000_000,
        cachedInputTokens: 26_656_000,
        cacheCreationTokens: 0,
        cacheEligibleInputTokens: 28_000_000,
        outputTokens: 1_000_000,
        reasoningTokens: 0,
        otherInputTokens: 0,
        otherOutputTokens: 0,
        totalTokens: 29_000_000,
        turns: 24,
        sessions: 8,
      },
    ],
    daily: [{ day: "2026-11-26" as UsageDay, messages: 40, turns: 6, totalTokens: 2_000_000 }],
  },
}));

vi.mock(import("~/state/entities"), async (original) => ({
  ...(await original()),
  useProjects: () => state.projects as never,
}));

vi.mock(import("~/state/environments"), async (original) => ({
  ...(await original()),
  useEnvironments: (() => ({
    isReady: true,
    networkStatus: "online",
    environments: [
      {
        environmentId: EnvironmentId.make("local"),
        label: "Local",
      },
    ],
    presentationById: new Map(),
  })) as never,
}));

vi.mock(import("~/hooks/useScratchProject"), () => ({
  useScratchProject: (() => ({
    scratchWorkspaceRootFor: () => null,
  })) as never,
}));

vi.mock(import("~/state/presentation"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  return {
    ...actual,
    environmentPresentations: {
      ...actual.environmentPresentations,
      presentationsWithProvidersAtom: Atom.make(() => state.presentations),
    } as never,
  };
});

vi.mock(import("~/state/use-atom-command"), () => ({
  useAtomCommand: () => async () => ({ _tag: "Success" }) as never,
}));

vi.mock(import("~/state/workspaceUsage"), () => ({
  useWorkspaceUsageStats: ({
    range,
    selectedProjectRefs,
  }: {
    range: string;
    selectedProjectRefs: ReadonlyArray<{ readonly projectId: string }> | null;
  }) => {
    state.calls.push({
      range,
      projectIds: selectedProjectRefs?.map((ref) => ref.projectId) ?? null,
    });
    return {
      todayDay: UsageDay.make("2026-11-26"),
      merged: state.merged,
      isPending: false,
      isRefreshing: false,
      hasError: false,
    };
  },
}));

vi.mock(import("../CommandPaletteLookups"), () => ({
  useSortedProjectGroups: () =>
    state.projects.map((project) => ({
      ...project,
      projectKey: `${project.environmentId}:${project.id}`,
      displayName: project.title,
      groupedProjectCount: 1,
      environmentPresence: "local-only" as const,
      allRemoteMembersAreDesktopLocal: false,
      allRemoteMembersAreWsl: false,
      memberProjectRefs: [{ environmentId: project.environmentId, projectId: project.id }],
      memberProjects: [
        {
          ...project,
          physicalProjectKey: project.workspaceRoot,
          environmentLabel: "Local",
        },
      ],
      remoteEnvironmentLabels: [],
      pinned: false,
      archived: false,
    })),
}));

vi.mock(import("../ProjectFavicon"), () => ({
  ProjectFavicon: () => <span data-testid="project-favicon" />,
}));

import { DraftHeroOverviewCard } from "./DraftHeroOverviewCard";

const envId = EnvironmentId.make("local");
const projA = ProjectId.make("proj-a");

const provider: ServerProvider = {
  instanceId: ProviderInstanceId.make("antigravity"),
  driver: ProviderDriverKind.make("antigravity"),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-11-26T00:00:00.000Z",
  models: [
    {
      slug: "gemini-4-neon",
      name: "Gemini 4 Neon",
      shortName: "Gemini 4 Neon",
      isCustom: false,
      capabilities: null,
    },
  ],
  slashCommands: [],
  skills: [],
  usageLimits: {
    checkedAt: "2026-11-26T12:00:00.000Z",
    windows: [
      {
        id: "session",
        kind: "session",
        label: "Session",
        usedPercent: 25,
      },
    ],
  },
};

function setup() {
  window.localStorage.clear();
  state.calls = [];
  state.projects = [
    {
      environmentId: envId,
      id: projA,
      title: "Alpha App",
      workspaceRoot: "/tmp/alpha",
      defaultModelSelection: null,
      scripts: [],
      createdAt: "2026-11-20T00:00:00.000Z",
      updatedAt: "2026-11-26T00:00:00.000Z",
    },
  ];
  state.presentations = new Map([
    [
      envId,
      {
        entry: { target: { label: "Local" } },
        connection: { phase: "connected" },
        serverConfig: { providers: [provider], usageLimitSources: [] },
      },
    ],
  ]);
}

describe("DraftHeroOverviewCard", () => {
  it("renders expanded by default, switches tabs/ranges/project filter, and toggles collapse", async () => {
    await page.viewport(1280, 800);
    setup();
    await using screen = await render(<DraftHeroOverviewCard draftId={null} />);

    await expect.element(screen.getByText("Sessions")).toBeVisible();
    await expect.element(screen.getByText("182")).toBeVisible();
    await expect.element(screen.getByText("29M")).toBeVisible();
    await expect.element(screen.getByText("95.2%")).toBeVisible();
    await expect.element(screen.getByText("Gemini 4 Neon")).toBeVisible();

    const heatmapCell = document.querySelector(
      '[aria-label*="tokens"][aria-label*="messages"]',
    ) as HTMLElement | null;
    expect(heatmapCell).not.toBeNull();
    const cellRect = heatmapCell!.getBoundingClientRect();
    expect(cellRect.width).toBeGreaterThan(0);
    expect(cellRect.height).toBeGreaterThan(0);
    expect(Math.abs(cellRect.width - cellRect.height)).toBeLessThan(2);

    // Switch time range to 7 days
    await userEvent.click(screen.getByRole("button", { name: "7 days" }));
    expect(state.calls.at(-1)?.range).toBe("7d");

    // Filter by project
    await userEvent.click(screen.getByRole("combobox", { name: "Filter by project" }));
    await userEvent.click(page.getByRole("option", { name: "Alpha App" }));
    expect(state.calls.at(-1)?.projectIds).toEqual([projA]);

    // Switch to Models tab
    await userEvent.click(screen.getByRole("button", { name: "Models" }));
    await expect.element(screen.getByText("100.0%")).toBeVisible();

    // Switch to Model quota tab
    await userEvent.click(screen.getByRole("button", { name: "Model quota" }));
    await expect.element(screen.getByText("75%")).toBeVisible();

    // Collapse & re-expand
    await userEvent.click(screen.getByRole("button", { name: "Hide overview" }));
    await expect.element(screen.getByRole("button", { name: "Overview" })).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Overview" }));
    await expect.element(screen.getByText("Model quota")).toBeVisible();
  });
});
