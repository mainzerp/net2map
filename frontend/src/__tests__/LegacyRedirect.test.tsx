import React from "react";
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import LegacyRedirect from "../components/LegacyRedirect";

function Where() {
  const { pathname, search } = useLocation();
  return <div data-testid="where">{`${pathname}${search}`}</div>;
}

describe("LegacyRedirect", () => {
  it("sends /devices to /endpoints and keeps the query string", () => {
    render(
      <MemoryRouter initialEntries={["/devices?inspect=endpoint:5&q=nas"]}>
        <Routes>
          <Route path="/devices" element={<LegacyRedirect to="/endpoints" />} />
          <Route path="/endpoints" element={<Where />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByTestId("where").textContent).toBe("/endpoints?inspect=endpoint:5&q=nas");
  });
});
