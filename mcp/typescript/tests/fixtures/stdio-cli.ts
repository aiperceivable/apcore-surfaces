import { Config } from "apcore-js/config";
import { Registry } from "apcore-js/full";
// Instrument configuration construction without replacing the real SDK Config.
const load = Config.load;
Config.load = (...args: Parameters<typeof load>) => {
  console.log("config bootstrap diagnostic");
  return load.apply(Config, args);
};
const discover = Registry.prototype.discover;
Registry.prototype.discover = function (...args: Parameters<typeof discover>) {
  console.log("discovery bootstrap diagnostic");
  return discover.apply(this, args);
};
process.argv = [process.argv[0], "apcore-mcp", "--extensions-dir", "tests/fixtures/stdio-extensions", "--no-async"];
const { main } = await import("../../src/cli.js");
await main();
