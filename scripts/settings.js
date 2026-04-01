import { MODULE_ID } from "./config.js";

export function registerKeybinding(openBulkEditForSelection) {
  const { SHIFT } = foundry.helpers.interaction.KeyboardManager.MODIFIER_KEYS;

  game.keybindings.register(MODULE_ID, "openBulkEdit", {
    name: "MINIEDIT.keybindings.open.name",
    hint: "MINIEDIT.keybindings.open.hint",
    editable: [{ key: "KeyM", modifiers: [SHIFT] }],
    restricted: true,
    precedence: CONST.KEYBINDING_PRECEDENCE.NORMAL,
    onDown: () => {
      openBulkEditForSelection();
      return true;
    },
  });
}
