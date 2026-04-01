import { MODULE_ID, SUPPORTED_CONTROLS } from "./config.js";
import { openBulkEditForSelection } from "./mini-edit.js";
import { registerKeybinding } from "./settings.js";

function registerSceneControlButtons() {
  Hooks.on("getSceneControlButtons", (controls) => {
    if (!game.user?.isGM) return;

    for (const controlName of SUPPORTED_CONTROLS) {
      const control = controls[controlName];
      if (!control?.tools) continue;

      const toolName = `${MODULE_ID}-open`;
      if (toolName in control.tools) continue;

      control.tools[toolName] = {
        name: toolName,
        title: "MINIEDIT.controls.open",
        icon: "fa-solid fa-pen-to-square",
        button: true,
        visible: true,
        onChange: () => openBulkEditForSelection(),
      };
    }
  });
}

Hooks.once("init", () => {
  game.modules.get(MODULE_ID).api = {
    open: () => openBulkEditForSelection(),
  };

  registerSceneControlButtons();
  registerKeybinding(openBulkEditForSelection);
});
