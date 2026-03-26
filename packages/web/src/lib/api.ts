import axios from "axios";
import { useAuthStore } from "../stores/auth.js";

export const apiClient = axios.create({
  baseURL: import.meta.env["VITE_API_URL"] ?? "",
  headers: { "Content-Type": "application/json" },
});

// Attach auth token to every request
apiClient.interceptors.request.use((config) => {
  const token = useAuthStore.getState().token;
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// Redirect to login on 401
apiClient.interceptors.response.use(
  (response) => response,
  (error: unknown) => {
    if (axios.isAxiosError(error) && error.response?.status === 401) {
      useAuthStore.getState().logout();
      window.location.href = "/login";
    }
    return Promise.reject(error);
  }
);
