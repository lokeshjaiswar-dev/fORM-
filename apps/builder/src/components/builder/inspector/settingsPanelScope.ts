import { createContext, useContext } from 'react';

/**
 * True inside the two settings panels (block settings on the right, Form settings). Menus open in a portal outside the
 * panel, so a select reads this to mark its menu for the panel's Figma dropdown styling (inspectorFields.css).
 */
export const SettingsPanelContext = createContext(false);

export const useInSettingsPanel = (): boolean => useContext(SettingsPanelContext);
