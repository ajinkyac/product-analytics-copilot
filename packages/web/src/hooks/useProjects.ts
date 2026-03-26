import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../lib/api.js";
import type { Project } from "@copilot/shared";

export function useProjects() {
  return useQuery<Project[]>({
    queryKey: ["projects"],
    queryFn: async () => {
      const response = await apiClient.get<{ data: Project[] }>("/v1/projects");
      return response.data.data;
    },
  });
}

export function useProject(projectId: string | null) {
  return useQuery<Project>({
    queryKey: ["projects", projectId],
    queryFn: async () => {
      const response = await apiClient.get<Project>(`/v1/projects/${projectId}`);
      return response.data;
    },
    enabled: !!projectId,
  });
}

export function useCreateProject() {
  const queryClient = useQueryClient();

  return useMutation<Project, Error, { name: string; description?: string; color?: string }>({
    mutationFn: async (data) => {
      const response = await apiClient.post<Project>("/v1/projects", data);
      return response.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
    },
  });
}
