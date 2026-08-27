export interface IHashProvider {
  /** The result encodes its own parameters and salt. */
  hash(plain: string): Promise<string>
}
