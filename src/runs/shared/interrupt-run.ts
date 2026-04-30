import { readStatus } from "../../shared/utils.ts";
import type { SubagentState } from "../../shared/types.ts";

const ASYNC_INTERRUPT_SIGNAL: NodeJS.Signals = process.platform === "win32" ? "SIGBREAK" : "SIGUSR2";

export interface InterruptResult {
	ok: boolean;
	message: string;
	runId?: string;
	kind?: "foreground" | "async";
}

function getForegroundControl(state: SubagentState, runId: string | undefined) {
	if (runId) return state.foregroundControls.get(runId);
	if (state.lastForegroundControlId) {
		const latest = state.foregroundControls.get(state.lastForegroundControlId);
		if (latest) return latest;
	}
	let newest: ReturnType<typeof state.foregroundControls.get> | undefined;
	for (const control of state.foregroundControls.values()) {
		if (!newest || control.updatedAt > newest.updatedAt) newest = control;
	}
	return newest;
}

function getAsyncInterruptTarget(state: SubagentState, runId: string | undefined): { asyncId: string; asyncDir: string } | undefined {
	if (runId) {
		const direct = state.asyncJobs.get(runId);
		if (direct) return { asyncId: direct.asyncId, asyncDir: direct.asyncDir };
	}
	let newest: { asyncId: string; asyncDir: string; updatedAt: number } | undefined;
	for (const job of state.asyncJobs.values()) {
		if (job.status !== "running") continue;
		if (!newest || (job.updatedAt ?? 0) > newest.updatedAt) {
			newest = { asyncId: job.asyncId, asyncDir: job.asyncDir, updatedAt: job.updatedAt ?? 0 };
		}
	}
	return newest ? { asyncId: newest.asyncId, asyncDir: newest.asyncDir } : undefined;
}

/**
 * Interrupt (soft-pause) a foreground or async subagent run by id.
 * If no id is given, targets the most recently updated run in this session.
 * Foreground runs are interrupted via their stored callback; async runs are
 * signalled via SIGUSR2 (SIGBREAK on Windows) to the runner pid in status.json.
 */
export function interruptRunById(state: SubagentState, runId?: string): InterruptResult {
	const foreground = getForegroundControl(state, runId);
	if (foreground?.interrupt) {
		const interrupted = foreground.interrupt();
		if (interrupted) {
			foreground.updatedAt = Date.now();
			foreground.currentActivityState = undefined;
			return { ok: true, kind: "foreground", runId: foreground.runId, message: `Interrupt requested for foreground run ${foreground.runId}.` };
		}
		return { ok: false, kind: "foreground", runId: foreground.runId, message: `Foreground run ${foreground.runId} has no active child step to interrupt.` };
	}

	const target = getAsyncInterruptTarget(state, runId);
	if (!target) {
		return { ok: false, message: runId ? `No interrupt-capable run found for '${runId}'.` : "No interrupt-capable run found in this session." };
	}
	const status = readStatus(target.asyncDir);
	if (!status || status.state !== "running" || typeof status.pid !== "number") {
		return { ok: false, kind: "async", runId: target.asyncId, message: `No running async run with an interrupt-capable pid was found for '${target.asyncId}'.` };
	}
	try {
		process.kill(status.pid, ASYNC_INTERRUPT_SIGNAL);
		const tracked = state.asyncJobs.get(target.asyncId);
		if (tracked) {
			tracked.activityState = undefined;
			tracked.updatedAt = Date.now();
		}
		return { ok: true, kind: "async", runId: target.asyncId, message: `Interrupt requested for async run ${target.asyncId}.` };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { ok: false, kind: "async", runId: target.asyncId, message: `Failed to interrupt async run ${target.asyncId}: ${message}` };
	}
}
