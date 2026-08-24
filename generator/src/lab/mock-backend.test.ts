import { describe, expect, it } from "vitest";
import { startMockBackend } from "./mock-backend.js";

describe("startMockBackend", () => {
  it("returns 404 for a path outside the known op set", async () => {
    const backend = await startMockBackend([{ method: "GET", path: "/users" }]);
    try {
      const res = await fetch(`http://127.0.0.1:${backend.port}/nonexistent`);
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toBe("not_found");
    } finally {
      await backend.close();
    }
  });

  it("returns 401 for a known op called without Authorization (credential-free path)", async () => {
    const backend = await startMockBackend([{ method: "GET", path: "/users" }]);
    try {
      const res = await fetch(`http://127.0.0.1:${backend.port}/users`);
      expect(res.status).toBe(401);
    } finally {
      await backend.close();
    }
  });

  it("returns 200 for a known op called with Authorization", async () => {
    const backend = await startMockBackend([{ method: "GET", path: "/users" }]);
    try {
      const res = await fetch(`http://127.0.0.1:${backend.port}/users`, {
        headers: { Authorization: "Bearer fake-token-for-shape-testing" },
      });
      expect(res.status).toBe(200);
    } finally {
      await backend.close();
    }
  });

  it("matches {param}-style path templates", async () => {
    const backend = await startMockBackend([{ method: "GET", path: "/users/{id}" }]);
    try {
      const res = await fetch(`http://127.0.0.1:${backend.port}/users/123`, {
        headers: { Authorization: "Bearer x" },
      });
      expect(res.status).toBe(200);
    } finally {
      await backend.close();
    }
  });

  it("records every request in requestLog", async () => {
    const backend = await startMockBackend([{ method: "GET", path: "/users" }]);
    try {
      await fetch(`http://127.0.0.1:${backend.port}/users`);
      await fetch(`http://127.0.0.1:${backend.port}/missing`);
      expect(backend.requestLog).toHaveLength(2);
      expect(backend.requestLog[0].status).toBe(401);
      expect(backend.requestLog[1].status).toBe(404);
    } finally {
      await backend.close();
    }
  });
});
