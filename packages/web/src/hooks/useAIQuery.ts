import { useMutation } from "@tanstack/react-query";
import { apiClient } from "../lib/api.js";
import type { AIQueryRequest, AIQueryResponse } from "@copilot/shared";

interface UseAIQueryOptions {
  onSuccess?: (result: AIQueryResponse) => void;
  onError?: (error: Error) => void;
}

export function useAIQuery(options?: UseAIQueryOptions) {
  return useMutation<AIQueryResponse, Error, AIQueryRequest>({
    mutationFn: async (request) => {
      const response = await apiClient.post<AIQueryResponse>("/v1/ai/query", request);
      return response.data;
    },
    onSuccess: options?.onSuccess,
    onError: options?.onError,
  });
}
