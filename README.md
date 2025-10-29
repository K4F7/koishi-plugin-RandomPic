# koishi-plugin-randompic

A Koishi plugin that sends truly random images from local galleries. The plugin bootstraps its working directories automatically so that users only need to drop images into folders.

## Features

- Automatically creates gallery folders under the configured root path on startup.
- Allows mapping multiple Koishi commands to one or more gallery folders.
- Supports per-command limits and optional recursive directory scanning.
- Sends images via `session.send` or `session.sendQueued` depending on configuration.

## Usage

1. Install the plugin and add it to your Koishi bot configuration.
2. Configure the `root` directory and define `commands` in the plugin settings.
3. Place image files in the generated gallery folders.
4. Use the registered Koishi commands to receive random images.

See the configuration schema in `src/index.ts` for all available options.

## Development

```bash
npm install
npm run build
```

The compiled files will be emitted to the `lib/` directory.
