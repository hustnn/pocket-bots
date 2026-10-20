/** An absolute folder path as typed: /…, ~/… (the home folder of the host it's on), C:\… or a \\share. */
export const ABSOLUTE_PATH = /^(\/|~(\/|$)|[A-Za-z]:[\\/]|\\\\)/;
