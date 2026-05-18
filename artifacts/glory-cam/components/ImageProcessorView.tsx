import React, { forwardRef, useImperativeHandle } from "react";

export type ProcessStep =
  | "noise"
  | "sharpen"
  | "enhance"
  | "face"
  | "hdr"
  | "filter"
  | "done"
  | "error";

export type CamMode = "PHOTO" | "PORTRAIT" | "NIGHT" | "VIDEO" | "PRO";
export type FilterType = "Natural" | "Vivid" | "Matte" | "B&W" | "Warm" | "Cool";
export type QualityType = "Fast" | "Max";

export interface ProcessOptions {
  mode: CamMode;
  filter: FilterType;
  quality: QualityType;
  exposure: number; // -1 to 1
}

export interface ProcessResult {
  processed: string;
  original: string;
}

export interface ProcessorHandle {
  process(
    frames: string[],
    onStep: (step: ProcessStep) => void,
    options: ProcessOptions
  ): Promise<ProcessResult>;
}

const ImageProcessorView = forwardRef<ProcessorHandle>((_, ref) => {
  useImperativeHandle(ref, () => ({
    process: (_f, _s, _o) =>
      Promise.reject(new Error("Not supported on web")),
  }));
  return null;
});

ImageProcessorView.displayName = "ImageProcessorView";
export default ImageProcessorView;
