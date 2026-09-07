/** qrcode-terminal 无官方类型（@types 未维护）—— 最小声明 */
declare module "qrcode-terminal" {
  export function generate(
    text: string,
    opts?: { small?: boolean; qrcode_utf8?: boolean },
    cb?: (qrcode: string) => void,
  ): void;
}
