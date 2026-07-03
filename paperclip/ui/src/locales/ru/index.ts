// Merged Russian dictionary. Each partN is owned by one translation pass so
// parallel edits never collide; add new strings to the part that owns the file
// the string appears in (see part headers).
import { part0 } from "./part0";
import { part1 } from "./part1";
import { part2 } from "./part2";
import { part3 } from "./part3";
import { part4 } from "./part4";
import { part5 } from "./part5";
import { part6 } from "./part6";
import { part7 } from "./part7";
import { part8 } from "./part8";

export const ru: Record<string, string> = {
  ...part0,
  ...part1,
  ...part2,
  ...part3,
  ...part4,
  ...part5,
  ...part6,
  ...part7,
  ...part8,
};
