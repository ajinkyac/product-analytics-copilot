import { create } from "zustand";
import type { ChartType, TimeRange } from "@copilot/shared";

interface UIState {
  // Active project
  activeProjectId: string | null;
  setActiveProjectId: (id: string | null) => void;

  // Sidebar
  sidebarCollapsed: boolean;
  setSidebarCollapsed: (v: boolean) => void;
  toggleSidebar: () => void;

  // Copilot panel
  copilotOpen: boolean;
  setCopilotOpen: (v: boolean) => void;

  // Query editor
  activeQueryTab: "editor" | "chart" | "ai";
  setActiveQueryTab: (tab: "editor" | "chart" | "ai") => void;

  // Chart type selection
  selectedChartType: ChartType;
  setSelectedChartType: (type: ChartType) => void;

  // Time range
  globalTimeRange: TimeRange;
  setGlobalTimeRange: (range: TimeRange) => void;
}

export const useUIStore = create<UIState>()((set) => ({
  activeProjectId: null,
  setActiveProjectId: (id) => set({ activeProjectId: id }),

  sidebarCollapsed: false,
  setSidebarCollapsed: (v) => set({ sidebarCollapsed: v }),
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),

  copilotOpen: true,
  setCopilotOpen: (v) => set({ copilotOpen: v }),

  activeQueryTab: "ai",
  setActiveQueryTab: (tab) => set({ activeQueryTab: tab }),

  selectedChartType: "line",
  setSelectedChartType: (type) => set({ selectedChartType: type }),

  globalTimeRange: "30d",
  setGlobalTimeRange: (range) => set({ globalTimeRange: range }),
}));
