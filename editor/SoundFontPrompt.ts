import { HTML } from "imperative-html/dist/esm/elements-strict";
import { SoundFontLibrary } from "../synth/SoundFont";
import { SongDocument } from "./SongDocument";

const { div, input, button, span, h2, a } = HTML;

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
                "Paste a direct .sf2 URL. ",
                a({ href: "https://filegarden.com/", target: "_blank" }, "File Garden"),
                " links work if the file can be fetched directly.",
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
        this._cancelButton.addEventListener("click", this._close);
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
        const url = this._urlInput.value.trim();
        if (url.length == 0) {
            this._status.textContent = "Paste a SoundFont URL first.";
            return;
        }

        this._loadButton.disabled = true;
        this._urlInput.disabled = true;
        this._status.textContent = "Loading SoundFont...";

        try {
            const font = await SoundFontLibrary.loadFromUrl(url);
            const firstPreset = font.getPresetInfos()[0];
            const instrument = this._getInstrument();

            instrument.soundFontUrl = url;
            instrument.soundFontName = font.name;
            instrument.soundFontBank = firstPreset.bank;
            instrument.soundFontPreset = firstPreset.preset;

            this._doc.notifier.changed();
            this._close();
        } catch (error) {
            this._status.textContent = error instanceof Error ? error.message : "Could not load this SoundFont.";
            this._loadButton.disabled = false;
            this._urlInput.disabled = false;
        }
    };

    private _close = (): void => {
        this._doc.prompt = null;
        this._doc.undo();
    };

    public cleanUp(): void {
        this._loadButton.removeEventListener("click", this._load);
        this._cancelButton.removeEventListener("click", this._close);
        this._urlInput.removeEventListener("keydown", this._whenKeyDown);
    }
}
