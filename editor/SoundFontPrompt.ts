import { HTML } from "imperative-html/dist/esm/elements-strict";
import { SoundFontLibrary, normalizeSoundFontUrl } from "../synth/SoundFont";
import { SongDocument } from "./SongDocument";

const { div, input, button, span, h2 } = HTML;

export class SoundFontPrompt {
    public gotMouseUp: boolean = false;

    private readonly _urlInput: HTMLInputElement = input({
        type: "text",
        placeholder: "https://file.garden/.../soundfont.sf2",
        style: "flex-grow: 1; min-width: 0;",
    });

    private readonly _status: HTMLDivElement = div({
        style: "min-height: 1.5em; margin-top: 0.5em; font-size: smaller; text-align: center;",
    });

    private readonly _loadButton: HTMLButtonElement = button({
        class: "okayButton",
        style: "width: 45%;",
    }, "Load");

    private readonly _cancelButton: HTMLButtonElement = button({ class: "cancelButton" });

    public readonly container: HTMLDivElement = div(
        { class: "prompt noSelection", style: "width: 450px; max-height: calc(100% - 100px);" },
        div(
            { style: "overflow-y: auto;" },
            div({ class: "promptTitle" }, h2({ style: "margin-bottom: 0.5em;" }, "Add SoundFont")),
            div(
                { style: "text-align: center; margin-bottom: 0.75em;" },
                "Paste a direct .sf2 file URL. For File Garden, use the file's Copy Link button so the URL starts with ",
                span({ style: "font-family: monospace;" }, "https://file.garden/"),
                ". ",
            ),
            div(
                { style: "border: 1px solid var(--ui-widget-background); border-radius: 4px; padding: 0.75em;" },
                div(
                    { class: "selectRow", style: "align-items: center;" },
                    span({ style: "flex: 0 0 auto; margin-right: 0.75em;" }, "URL"),
                    this._urlInput,
                ),
            ),
            this._status,
            div({ style: "display: flex; flex-direction: row-reverse; margin-top: 0.75em;" }, this._loadButton),
        ),
        this._cancelButton,
    );

    constructor(private readonly _doc: SongDocument) {
        const instrument = this._getInstrument();
        this._urlInput.value = instrument.soundFontUrl.startsWith("http://") || instrument.soundFontUrl.startsWith("https://") ? instrument.soundFontUrl : "";
        this._loadButton.addEventListener("click", this._load);
        this._cancelButton.addEventListener("click", this._cancel);
        this._urlInput.addEventListener("keydown", this._whenKeyDown);
        this._urlInput.focus();
    }

    private _getInstrument = () => {
        return this._doc.song.channels[this._doc.channel].instruments[this._doc.getCurrentInstrument()];
    };

    private _whenKeyDown = (event: KeyboardEvent): void => {
        if (event.key == "Enter") {
            event.preventDefault();
            this._load();
        }
    };

    private _load = async (): Promise<void> => {
        const inputUrl = this._urlInput.value.trim();
        if (inputUrl.length == 0) {
            this._status.textContent = "Paste a SoundFont URL first.";
            return;
        }

        const url = normalizeSoundFontUrl(inputUrl);

        this._loadButton.disabled = true;
        this._urlInput.disabled = true;
        this._status.textContent = "Connecting...";

        try {
            const font = await SoundFontLibrary.loadFromUrl(url, (loadedBytes, totalBytes) => {
                const loadedMB = loadedBytes / 1024 / 1024;

                if (totalBytes != null && totalBytes > 0) {
                    const totalMB = totalBytes / 1024 / 1024;
                    const percent = Math.min(100, Math.round(loadedBytes / totalBytes * 100));
                    this._status.textContent = "Downloading " + percent + "% (" + loadedMB.toFixed(1) + " / " + totalMB.toFixed(1) + " MB)";
                } else {
                    this._status.textContent = "Downloading " + loadedMB.toFixed(1) + " MB...";
                }
            });
            const presets = font.getPresetInfos();

            if (presets.length == 0) {
                throw new Error("This SoundFont does not contain any playable presets.");
            }

            const firstPreset = presets[0];
            const instrument = this._getInstrument();

            instrument.soundFontUrl = font.id;
            instrument.soundFontName = font.name;
            instrument.soundFontBank = firstPreset.bank;
            instrument.soundFontPreset = firstPreset.preset;

            this._urlInput.value = font.id;
            this._status.textContent = "Loaded " + font.name;
            this._doc.notifier.changed();

            requestAnimationFrame(() => this._finish());
        } catch (error) {
            const cached = await SoundFontLibrary.loadCached(url);

            if (cached != null) {
                const presets = cached.getPresetInfos();
                const instrument = this._getInstrument();

                if (presets.length > 0) {
                    instrument.soundFontUrl = cached.id;
                    instrument.soundFontName = cached.name;
                    instrument.soundFontBank = presets[0].bank;
                    instrument.soundFontPreset = presets[0].preset;
                    this._doc.notifier.changed();
                    this._status.textContent = "Loaded cached SoundFont.";
                    requestAnimationFrame(() => this._finish());
                    return;
                }
            }

            const message = error instanceof Error ? error.message : "Could not load this SoundFont.";
            console.error("SoundFont URL load failed:", url, error);
            this._status.textContent = message;
            this._loadButton.disabled = false;
            this._urlInput.disabled = false;
            this._urlInput.focus();
        }
    };

    private _finish = (): void => {
        this._doc.prompt = null;
        this._doc.notifier.changed();
    };

    private _cancel = (): void => {
        this._doc.prompt = null;
        this._doc.undo();
    };

    public cleanUp(): void {
        this._loadButton.removeEventListener("click", this._load);
        this._cancelButton.removeEventListener("click", this._cancel);
        this._urlInput.removeEventListener("keydown", this._whenKeyDown);
    }
}
