# koishi-plugin-random-pic

A Koishi plugin that sends a random picture link sourced from a configurable endpoint.

## Features

- Provides a `/random-pic` command that replies with a configurable image endpoint
- Ships with TypeScript typings and ESM output compatible with Koishi v4
- Ready-to-use build, lint, and test scripts for local development

## Usage

Install the plugin with your preferred package manager after publishing it to npm:

```bash
npm install koishi-plugin-random-pic
# or
pnpm add koishi-plugin-random-pic
```

Then enable it inside your Koishi configuration:

```ts
import { Context } from 'koishi'
import randomPic from 'koishi-plugin-random-pic'

export const name = 'bot'

export function apply(ctx: Context) {
  ctx.plugin(randomPic, {
    endpoint: 'https://picsum.photos/seed/koishi/800/600',
  })
}
```

## Development

Install dependencies and run the provided scripts:

```bash
npm install
npm run lint
npm run typecheck
npm run build
npm test
```

The build command produces bundled JavaScript and declaration files in the `lib/` directory ready for publication.

## License

[MIT](./LICENSE)
