// Fast-changing status-bar values (cursor coordinates, current view), kept apart from the main store
// so moving the mouse does not re-render the application.

import { create } from "zustand";

export const useStatus = create<{ cursor: string; view: string; it: string }>(() => ({ cursor: "", view: "Iso SW", it: "" }));
