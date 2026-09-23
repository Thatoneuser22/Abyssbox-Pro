export function getPianoRollSnapDivision(value: string, partsPerBeat: number, stepsPerBeat: number, beatsPerBar: number): number | null {
    const step: number = partsPerBeat / stepsPerBeat;
    let requested: number;

    switch (value) {
        case "none": return 1;
        case "step16": requested = step / 6; break;
        case "step14": requested = step / 4; break;
        case "step13": requested = step / 3; break;
        case "step12": requested = step / 2; break;
        case "step":
        case "line": requested = step; break;
        case "beat16": requested = partsPerBeat / 6; break;
        case "beat14": requested = partsPerBeat / 4; break;
        case "beat13": requested = partsPerBeat / 3; break;
        case "beat12": requested = partsPerBeat / 2; break;
        case "beat": return partsPerBeat;
        case "bar": return partsPerBeat * beatsPerBar;
        default: return null;
    }

    return requested >= 1 && Number.isInteger(requested) ? requested : null;
}
