/**
 * Tests for LoginPage component.
 */
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithRouter } from "./test-utils";
import LoginPage from "../pages/LoginPage";

// Mock react-router-dom navigate
const mockNavigate = vi.fn();
vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual("react-router-dom");
  return { ...actual, useNavigate: () => mockNavigate };
});

// Mock the api module
const mockApiPost = vi.fn();
const mockVerifyAccessToken = vi.fn();
vi.mock("../api", () => ({
  API: "",
  login: vi.fn(),
  verifyAccessToken: (...args: unknown[]) => mockVerifyAccessToken(...args),
  extractErrorMessage: (ex: unknown) => (ex instanceof Error ? ex.message : String(ex)),
  api: { post: (...args: unknown[]) => mockApiPost(...args) },
}));

describe("LoginPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the login form with username and password fields", () => {
    renderWithRouter(<LoginPage />);
    expect(screen.getByText("Net2Map Login")).toBeTruthy();
    expect(screen.getByLabelText(/username/i)).toBeTruthy();
    expect(screen.getByLabelText(/password/i)).toBeTruthy();
  });

  it("submits credentials and navigates on success", async () => {
    const user = userEvent.setup();
    const { login } = await import("../api");

    mockApiPost.mockResolvedValueOnce({
      access_token: "jwt-token-123",
      username: "admin",
      role: "admin",
    });

    renderWithRouter(<LoginPage />);

    await user.type(screen.getByLabelText(/username/i), "admin");
    await user.type(screen.getByLabelText(/password/i), "pass123");
    await user.click(screen.getByRole("button", { name: /sign in/i }));

    await waitFor(() => {
      expect(mockApiPost).toHaveBeenCalledWith("/api/auth/login", {
        username: "admin",
        password: "pass123",
      });
    });

    await waitFor(() => {
      expect(login).toHaveBeenCalledWith("jwt-token-123", { username: "admin", role: "admin" });
      expect(mockNavigate).toHaveBeenCalledWith("/", { replace: true });
    });
  });

  it("displays error message on failed login", async () => {
    const user = userEvent.setup();

    mockApiPost.mockRejectedValueOnce(new Error("HTTP 401: Invalid credentials"));

    renderWithRouter(<LoginPage />);

    await user.type(screen.getByLabelText(/username/i), "bad");
    await user.type(screen.getByLabelText(/password/i), "wrong");
    await user.click(screen.getByRole("button", { name: /sign in/i }));

    await waitFor(() => {
      expect(screen.getByText("Invalid credentials")).toBeTruthy();
    });
  });

  it("signs in with an access token in single-token mode", async () => {
    const user = userEvent.setup();
    const { login } = await import("../api");

    mockVerifyAccessToken.mockResolvedValueOnce({ username: "legacy", role: "admin" });

    renderWithRouter(<LoginPage />);

    await user.click(screen.getByRole("button", { name: /access token instead/i }));
    await user.type(screen.getByLabelText(/access token/i), "  static-secret  ");
    await user.click(screen.getByRole("button", { name: /sign in/i }));

    await waitFor(() => {
      expect(mockVerifyAccessToken).toHaveBeenCalledWith("static-secret");
      expect(login).toHaveBeenCalledWith("static-secret", { username: "legacy", role: "admin" });
      expect(mockNavigate).toHaveBeenCalledWith("/", { replace: true });
    });
    expect(mockApiPost).not.toHaveBeenCalled();
  });
});
