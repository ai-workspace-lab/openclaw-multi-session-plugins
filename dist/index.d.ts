import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
declare const plugin: {
    id: string;
    name: string;
    description: string;
    register: typeof register;
};
export default plugin;
declare function register(api: OpenClawPluginApi): void;
