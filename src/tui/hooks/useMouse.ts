/**
 * Mouse event handler for Ink TUI.
 *
 * Ink 5 has limited mouse support. This hook provides the interface
 * for mouse events. Currently a no-op; full mouse support can be
 * added when Ink provides a stable useMouse hook.
 */
export function useMouse(
	_actions: Record<string, (...args: any[]) => void>,
): void {
	// Mouse support is not yet implemented for Ink 5.
	// Keyboard navigation is fully functional.
}
