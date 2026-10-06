import { afterEach, describe, expect, it, vi } from "vitest";
import { ReminderTools, nextClockTime } from "../src/orchestrator/reminder-tools.js";

afterEach(() => vi.useRealTimers());

describe("nextClockTime", () => {
  const now = new Date(2026, 9, 6, 15, 30); // Oct 6, 3:30 pm local
  it("picks the next occurrence, rolling to tomorrow when it has passed", () => {
    expect(nextClockTime("17:00", now)).toEqual(new Date(2026, 9, 6, 17, 0));
    expect(nextClockTime("9:05", now)).toEqual(new Date(2026, 9, 7, 9, 5));
    expect(nextClockTime("15:30", now)).toEqual(new Date(2026, 9, 7, 15, 30));
  });
  it("rejects things that aren't times", () => {
    expect(nextClockTime("5pm", now)).toBeUndefined();
    expect(nextClockTime("25:00", now)).toBeUndefined();
  });
});

describe("reminders", () => {
  it("speaks up through notify when the time comes, once", () => {
    vi.useFakeTimers();
    const notices: string[] = [];
    const tools = new ReminderTools();
    const ctx = { userTranscript: "", notify: (t: string) => notices.push(t) };
    expect(tools.execute("set_reminder", '{"text":"check the oven","in_minutes":20}', ctx)).toMatchObject({ ok: true, id: "r1", in_minutes: 20 });
    vi.advanceTimersByTime(19 * 60_000);
    expect(notices).toEqual([]);
    vi.advanceTimersByTime(60_000);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("check the oven");
    vi.advanceTimersByTime(60 * 60_000);
    expect(notices).toHaveLength(1);
    expect(tools.execute("list_reminders", "{}", ctx)).toEqual({ reminders: [] });
  });

  it("lists and cancels", () => {
    vi.useFakeTimers();
    const notices: string[] = [];
    const tools = new ReminderTools();
    const ctx = { userTranscript: "", notify: (t: string) => notices.push(t) };
    tools.execute("set_reminder", '{"text":"a","in_minutes":10}', ctx);
    tools.execute("set_reminder", '{"text":"b","in_minutes":5}', ctx);
    expect((tools.execute("list_reminders", "{}", ctx) as { reminders: { text: string }[] }).reminders.map((r) => r.text)).toEqual(["b", "a"]);
    expect(tools.execute("cancel_reminder", '{"id":"r2"}', ctx)).toEqual({ ok: true, cancelled: ["b"] });
    expect(tools.execute("cancel_reminder", '{"id":"all"}', ctx)).toEqual({ ok: true, cancelled: ["a"] });
    vi.advanceTimersByTime(60 * 60_000);
    expect(notices).toEqual([]);
  });

  it("refuses what it can't keep: no time, a time too far off, or nobody to tell", () => {
    const tools = new ReminderTools();
    const ctx = { userTranscript: "", notify: () => {} };
    expect(tools.execute("set_reminder", '{"text":"x"}', ctx)).toHaveProperty("error");
    expect(tools.execute("set_reminder", '{"text":"x","in_minutes":3000}', ctx)).toMatchObject({ error: expect.stringContaining("24 hours") });
    expect(tools.execute("set_reminder", '{"text":"x","at":"soon"}', ctx)).toHaveProperty("error");
    expect(tools.execute("set_reminder", '{"text":"x","in_minutes":5}', { userTranscript: "" })).toMatchObject({ error: expect.stringContaining("nobody") });
    tools.dispose();
  });
});
