import { MODULE_ID, SUPPORTED_DOCUMENTS } from "./config.js";

const BULK_SHEET_CLASS_CACHE = new Map();
const OPEN_APPS = new Map();

const uniqueDocuments = (documents) =>
  Array.from(new Map(documents.filter((doc) => doc?.id).map((doc) => [doc.id, doc])).values());

const documentsSignature = (documents) => documents.map((doc) => doc.id).sort().join("|");

function valuesEqual(left, right) {
  if (left === right) return true;
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch (_err) {
    return false;
  }
}

function computeCommonFlatData(documents) {
  if (!documents?.length) return {};

  const common = foundry.utils.flattenObject(documents[0].toObject());
  for (const [key] of Object.entries(common)) {
    if (key.startsWith("_")) delete common[key];
  }

  for (let i = 1; i < documents.length; i += 1) {
    const flat = foundry.utils.flattenObject(documents[i].toObject());
    for (const [key, value] of [...Object.entries(common)]) {
      if (!(key in flat) || !valuesEqual(value, flat[key])) delete common[key];
    }
  }

  return common;
}

function toFlagDeletionKey(fieldPath) {
  if (!fieldPath.startsWith("flags.")) return null;
  const parts = fieldPath.split(".");
  if (parts.length < 3) return null;
  return `${parts.slice(0, -1).join(".")}.-=${parts.at(-1)}`;
}

function collectControlledByType() {
  const selection = {};
  if (!canvas?.ready) return selection;

  for (const documentName of SUPPORTED_DOCUMENTS) {
    const layer = canvas.getLayerByEmbeddedName(documentName);
    const docs = layer?.controlled?.map((placeable) => placeable.document).filter(Boolean) ?? [];
    if (!docs.length) continue;
    selection[documentName] = uniqueDocuments(docs);
  }

  return selection;
}

async function promptDocumentType(selection) {
  const entries = Object.entries(selection);
  if (!entries.length) return null;
  if (entries.length === 1) return entries[0]?.[0];

  const buttons = entries.map(([documentName, docs], index) => ({
    action: documentName,
    label: `${documentName} (${docs.length})`,
    default: index === 0,
    callback: () => documentName,
  }));

  buttons.push({
    action: "cancel",
    label: game.i18n.localize("Cancel"),
    callback: () => null,
  });

  return foundry.applications.api.DialogV2.wait({
    window: { title: game.i18n.localize("MINIEDIT.dialog.title") },
    content: `<p>${game.i18n.localize("MINIEDIT.dialog.content")}</p>`,
    buttons,
    modal: true,
    rejectClose: false,
  });
}

function resolveSheetClass(documentName, targetDocument) {
  const appV2 = foundry.applications.api.ApplicationV2;

  // Prefer the effective sheet class currently used by the target.
  const liveSheetClass = targetDocument?.sheet?.constructor;
  if (liveSheetClass && foundry.utils.isSubclass(liveSheetClass, appV2)) return liveSheetClass;

  const registry = CONFIG[documentName]?.sheetClasses;
  if (!registry) return null;

  const candidates = [];
  for (const scope of Object.values(registry)) {
    for (const config of Object.values(scope ?? {})) {
      if (config?.cls && foundry.utils.isSubclass(config.cls, appV2)) candidates.push(config);
    }
  }

  if (!candidates.length) return null;
  return (candidates.find((candidate) => candidate.default)?.cls ?? candidates.at(-1)?.cls) || null;
}

function createBulkSheetClass(documentName, baseClass) {
  const cacheKey = `${documentName}:${baseClass.name}`;
  if (BULK_SHEET_CLASS_CACHE.has(cacheKey)) return BULK_SHEET_CLASS_CACHE.get(cacheKey);

  class MiniBulkSheet extends baseClass {
    static get DEFAULT_OPTIONS() {
      const parentOptions = super.DEFAULT_OPTIONS ?? {};
      const parentClasses = parentOptions.classes ?? [];
      const parentSubmitHandler = parentOptions.form?.handler;

      return foundry.utils.mergeObject(
        parentOptions,
        {
          classes: Array.from(new Set([...parentClasses, "mini-edit-sheet"])),
          form: {
            submitOnChange: false,
            closeOnSubmit: false,
            handler(event, form, formData) {
              if (this._onBulkSubmit instanceof Function) {
                return this._onBulkSubmit(event, form, formData);
              }
              if (parentSubmitHandler instanceof Function) {
                return parentSubmitHandler.call(this, event, form, formData);
              }
              return undefined;
            },
          },
        },
        { inplace: false }
      );
    }

    constructor(options = {}) {
      super(options);
      this._meDocuments = uniqueDocuments(options.meDocuments ?? []);
      this._meDocumentSignature = documentsSignature(this._meDocuments);
      this._meDocumentName = options.meDocumentName ?? documentName;
      this._meCommonData = computeCommonFlatData(this._meDocuments);
      this._meSelectedFieldNames = new Set();
      this._meMutationObserver = null;
      this._instanceKey = options.meDocumentName ?? documentName;
    }

    get title() {
      const baseTitle = super.title ?? this._meDocumentName;
      return `${baseTitle} [Mini Edit x${this._meDocuments.length}]`;
    }

    setBulkDocuments(documents) {
      const normalized = uniqueDocuments(documents);
      const nextSignature = documentsSignature(normalized);
      if (nextSignature === this._meDocumentSignature) return false;

      this._meDocuments = normalized;
      this._meDocumentSignature = nextSignature;
      this._meCommonData = computeCommonFlatData(this._meDocuments);
      return true;
    }

    render(...args) {
      this._captureSelectedFieldNamesFromForm();
      return super.render(...args);
    }

    _onClose(options) {
      this._meMutationObserver?.disconnect();
      this._meMutationObserver = null;
      super._onClose?.(options);
      if (OPEN_APPS.get(this._instanceKey) === this) OPEN_APPS.delete(this._instanceKey);
    }

    async _onRender(context, options) {
      await super._onRender?.(context, options);
      this._injectBulkEditControls();
      this._observeLateFormChanges();
    }

    _captureSelectedFieldNamesFromForm() {
      const form = this.form;
      if (!form) return;

      const selected = new Set();
      for (const group of form.querySelectorAll(".form-group")) {
        const checkbox = group.querySelector(".mini-edit-control");
        if (!checkbox?.checked) continue;
        for (const fieldName of this._getGroupFieldNames(group)) selected.add(fieldName);
      }
      this._meSelectedFieldNames = selected;
    }

    _getGroupFieldNames(group) {
      return Array.from(
        new Set(
          Array.from(group.querySelectorAll("[name]"))
            .map((field) => field.name)
            .filter(Boolean)
        )
      );
    }

    _observeLateFormChanges() {
      const form = this.form;
      if (!form) return;

      this._meMutationObserver?.disconnect();
      this._meMutationObserver = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          if (mutation.type === "attributes") {
            const target = mutation.target;
            if (target instanceof HTMLElement && target.closest(".form-group")) {
              this._injectBulkEditControls();
              return;
            }
            continue;
          }

          for (const node of mutation.addedNodes) {
            if (!(node instanceof HTMLElement)) continue;
            if (node.matches(".form-group") || node.querySelector(".form-group,[name]")) {
              this._injectBulkEditControls();
              return;
            }
          }
        }
      });

      this._meMutationObserver.observe(form, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["name"],
      });
    }

    _injectBulkEditControls() {
      const form = this.form;
      if (!form) return;

      for (const group of form.querySelectorAll(".form-group")) {
        if (group.querySelector(".mini-edit-checkbox")) continue;

        const fieldNames = this._getGroupFieldNames(group);
        if (!fieldNames.length) continue;

        let fieldType = "me-common";
        for (const fieldName of fieldNames) {
          if (fieldName.startsWith("flags.")) {
            fieldType = "me-flag";
            continue;
          }
          if (!(fieldName in this._meCommonData)) fieldType = "me-diff";
        }

        const checkboxWrap = document.createElement("div");
        checkboxWrap.classList.add("mini-edit-checkbox", fieldType);
        checkboxWrap.innerHTML = '<input type="checkbox" class="mini-edit-control" data-dtype="Boolean">';

        const anchor = group.querySelector("p.hint, p.notes");
        if (anchor) group.insertBefore(checkboxWrap, anchor);
        else group.appendChild(checkboxWrap);

        const checkbox = checkboxWrap.querySelector("input");
        const shouldSelect = fieldNames.some((fieldName) => this._meSelectedFieldNames.has(fieldName));
        if (shouldSelect) {
          checkbox.checked = true;
          group.classList.add("mini-edit-selected");
        }

        checkbox.addEventListener("change", () => {
          group.classList.toggle("mini-edit-selected", checkbox.checked);
        });
      }

      if (!form.dataset.miniEditListenersAttached) {
        form.dataset.miniEditListenersAttached = "true";

        const autoSelect = (event) => {
          const target = event.target;
          if (!(target instanceof HTMLElement)) return;
          if (target.closest(".mini-edit-checkbox")) return;

          const group = target.closest(".form-group");
          if (!group) return;
          if (!this._getGroupFieldNames(group).length) return;

          const checkbox = group.querySelector(".mini-edit-control");
          if (!checkbox || checkbox.checked) return;

          checkbox.checked = true;
          group.classList.add("mini-edit-selected");
        };

        form.addEventListener("input", autoSelect);
        form.addEventListener("change", autoSelect);
      }
    }

    _collectSelectedFields(flattenedSubmitData) {
      const form = this.form;
      if (!form) return {};

      const selectedFields = {};
      const names = new Set();

      for (const group of form.querySelectorAll(".form-group")) {
        const checkbox = group.querySelector(".mini-edit-control");
        if (!checkbox?.checked) continue;

        for (const fieldName of this._getGroupFieldNames(group)) names.add(fieldName);
      }

      for (const name of names) {
        if (name in flattenedSubmitData) {
          selectedFields[name] = flattenedSubmitData[name];
          continue;
        }

        if (name.startsWith("flags.")) {
          const deletionKey = toFlagDeletionKey(name);
          if (deletionKey) selectedFields[deletionKey] = null;
        }
      }

      return selectedFields;
    }

    async _onBulkSubmit(event, form, formData) {
      if (!this.isEditable) return;
      if (!this._meDocuments.length) {
        ui.notifications.warn(game.i18n.localize("MINIEDIT.notifications.noSelection"));
        return;
      }
      if (!form?.querySelector(".mini-edit-control:checked")) {
        ui.notifications.info(game.i18n.localize("MINIEDIT.notifications.noChanges"));
        return;
      }

      let submitData;
      try {
        submitData = this._prepareSubmitData
          ? this._prepareSubmitData(event, form, formData)
          : foundry.utils.expandObject(formData.object);
      } catch (err) {
        ui.notifications.error(err.message);
        return;
      }

      const preparedFlatSubmitData = foundry.utils.flattenObject(submitData);
      let rawFlatSubmitData = {};
      if (formData?.object && typeof formData.object === "object") {
        rawFlatSubmitData = foundry.utils.flattenObject(foundry.utils.expandObject(formData.object));
      }
      const flattenedSubmitData = { ...rawFlatSubmitData, ...preparedFlatSubmitData };
      const selectedFields = this._collectSelectedFields(flattenedSubmitData);
      if (foundry.utils.isEmpty(selectedFields)) {
        ui.notifications.info(game.i18n.localize("MINIEDIT.notifications.noChanges"));
        return;
      }

      const groupedEmbeddedUpdates = new Map();
      let preparedCount = 0;

      for (const document of this._meDocuments) {
        const parent = document.parent;
        if (!(parent?.updateEmbeddedDocuments instanceof Function)) continue;

        const update = foundry.utils.deepClone(selectedFields);
        update._id = document.id;
        if (!groupedEmbeddedUpdates.has(parent)) groupedEmbeddedUpdates.set(parent, []);
        groupedEmbeddedUpdates.get(parent).push(update);
        preparedCount += 1;
      }

      if (!preparedCount) {
        ui.notifications.info(game.i18n.localize("MINIEDIT.notifications.noChanges"));
        return;
      }

      try {
        for (const [parent, updates] of groupedEmbeddedUpdates) {
          await parent.updateEmbeddedDocuments(this._meDocumentName, updates);
        }
      } catch (err) {
        ui.notifications.error(
          game.i18n.format("MINIEDIT.errors.updateFailed", {
            documentName: this._meDocumentName,
          })
        );
        console.error(`${MODULE_ID} | Bulk update failed`, err);
        return;
      }

      const updatedCount = preparedCount;
      ui.notifications.info(
        game.i18n.format("MINIEDIT.notifications.applied", {
          count: updatedCount,
          types: this._meDocumentName,
        })
      );
      await this.close();
    }

    async _onMassSubmit(event, form, formData) {
      return this._onBulkSubmit(event, form, formData);
    }
  }

  Object.defineProperty(MiniBulkSheet, "name", {
    value: `MiniEdit${documentName}Config`,
  });

  BULK_SHEET_CLASS_CACHE.set(cacheKey, MiniBulkSheet);
  return MiniBulkSheet;
}

export async function openBulkEditForSelection() {
  if (!game.user?.isGM) {
    ui.notifications.warn(game.i18n.localize("MINIEDIT.errors.gmOnly"));
    return;
  }

  if (!canvas?.ready) {
    ui.notifications.warn(game.i18n.localize("MINIEDIT.errors.canvasNotReady"));
    return;
  }

  const selection = collectControlledByType();
  if (!Object.keys(selection).length) {
    ui.notifications.warn(game.i18n.localize("MINIEDIT.notifications.noSelection"));
    return;
  }

  const selectedType = await promptDocumentType(selection);
  if (!selectedType || !(selectedType in selection)) return;

  const documents = selection[selectedType];
  const target = documents[0];
  if (!target) return;

  const sheetClass = resolveSheetClass(selectedType, target);
  if (!sheetClass) {
    ui.notifications.error(game.i18n.format("MINIEDIT.errors.noSheetClass", { documentName: selectedType }));
    return;
  }


  const BulkSheetClass = createBulkSheetClass(selectedType, sheetClass);

  const existing = OPEN_APPS.get(selectedType);
  if (existing) {
    const changed = existing.setBulkDocuments(documents);
    if (changed) existing.render({ force: true });
    else existing.bringToFront();
    return;
  }

  const app = new BulkSheetClass({
    document: target,
    meDocuments: documents,
    meDocumentName: selectedType,
  });
  OPEN_APPS.set(selectedType, app);
  app.render({ force: true });
}
