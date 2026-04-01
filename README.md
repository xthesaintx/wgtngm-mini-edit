# Mini Edit
- Foundry VTT module for bulk editing controlled placeables
- Checkbox selection for targeted bulk updates
- GM-only editing

## Supported Documents
- `Token`
- `Tile`
- `Wall`
- `Drawing`
- `MeasuredTemplate`
- `AmbientLight`
- `AmbientSound`
- `Note`
- `Region`

## How It Works
- Select multiple placeables on canvas
- Open Mini Edit from scene controls or keybinding
- Edit values in the native config sheet
- Checkboxes automatically mark which fields to apply
- Submit applies checked fields to all selected documents

## Access
- Scene controls tool: `Mini Edit`
- Keybinding: `Shift + M`
- API: `game.modules.get("wgtngm-mini-edit").api.open()`
