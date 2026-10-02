/**
 * A NestJS route is named by the path a request takes to it — the app's
 * global prefix and URI version included.
 *
 * `app.setGlobalPrefix('api')` and `app.enableVersioning({ type:
 * VersioningType.URI, defaultVersion: '1' })` in `main.ts` put every
 * controller under `/api/v1`, but the routes were named `GET /user`. A front
 * end's `this.http.get('/api/v1/user')` then connected to nothing: Ghostfolio's
 * Angular client had no link to its own NestJS API.
 */
import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

const projects: string[] = [];
afterAll(() => {
  for (const p of projects.splice(0)) fs.rmSync(p, { recursive: true, force: true });
});

async function project(files: Record<string, string>): Promise<CodeGraph> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-nest-prefix-'));
  projects.push(root);
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  return CodeGraph.init(root, { index: true });
}

const MAIN = `import { NestFactory } from '@nestjs/core';
import { VersioningType } from '@nestjs/common';
import { AppModule } from './app/app.module';
async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableVersioning({ defaultVersion: '1', type: VersioningType.URI });
  app.setGlobalPrefix('api', { exclude: ['sitemap.xml', 'health{/*wildcard}'] });
  await app.listen(3333);
}
bootstrap();
`;

describe('NestJS: the global prefix and URI versioning', () => {
  it('names each route under the prefix and its version — or neither, where the app says so', async () => {
    const cg = await project({
      'package.json': JSON.stringify({ dependencies: { '@nestjs/core': '^11.0.0', '@nestjs/common': '^11.0.0' } }),
      'apps/api/src/main.ts': MAIN,
      // A seed script creates the same app without serving it — and is read first.
      'apps/api/src/database/run-seed.ts': `import { NestFactory } from '@nestjs/core';
const runSeed = async () => {
  const app = await NestFactory.create(SeedModule);
  await app.close();
};
void runSeed();
`,
      'apps/api/src/app/user.controller.ts': `import { Controller, Get, Post, Version, VERSION_NEUTRAL } from '@nestjs/common';
@Controller('user')
export class UserController {
  @Get()
  public getUser() {}

  @Post()
  @UseGuards(AuthGuard('jwt'))
  @Version('2')
  public createUser() {}

  @Get('oidc/callback')
  @Version(VERSION_NEUTRAL)
  public callback() {}
}
`,
      'apps/api/src/app/sitemap.controller.ts': `import { Controller, Get, Version, VERSION_NEUTRAL } from '@nestjs/common';
@Controller()
@Version(VERSION_NEUTRAL)
export class SitemapController {
  @Get('sitemap.xml')
  public sitemap() {}
}
`,
      'apps/api/src/app/health.controller.ts': `import { Controller, Get } from '@nestjs/common';
@Controller({ path: 'health', version: '3' })
export class HealthController {
  @Get('db')
  public db() {}
}
`,
      // A second app that sets nothing: its routes stay as written.
      'apps/jobs/src/main.ts': `import { NestFactory } from '@nestjs/core';
NestFactory.create(JobsModule).then((app) => app.listen(3335));
`,
      'apps/jobs/src/jobs.controller.ts': `import { Controller, Get } from '@nestjs/common';
@Controller('jobs')
export class JobsController {
  @Get()
  public list() {}
}
`,
    });
    try {
      expect(
        cg
          .getNodesByKind('route')
          .map((r) => r.name)
          .sort()
      ).toEqual([
        // VERSION_NEUTRAL: prefixed, not versioned.
        'GET /api/user/oidc/callback',
        'GET /api/v1/user',
        'GET /jobs',
        'GET /sitemap.xml',
        // Excluded from the prefix, still versioned by its controller.
        'GET /v3/health/db',
        'POST /api/v2/user',
      ]);
    } finally {
      cg.close();
    }
  });

  it('reads a version past decorators with object arguments, and each app its own bootstrap', async () => {
    const cg = await project({
      'package.json': JSON.stringify({ dependencies: { '@nestjs/core': '^11.0.0', '@nestjs/common': '^11.0.0' } }),
      'apps/api/src/main.ts': MAIN,
      'apps/api/src/app/stats.controller.ts': `import { Controller, Get, Version } from '@nestjs/common';
@Controller('stats')
export class StatsController {
  @Version('2')
  @ApiResponse({ status: 200, description: 'The stats' })
  @Get('daily')
  public daily() {}

  @Get('weekly')
  public weekly() {}
}
`,
      'apps/api/src/app/reports.controller.ts': `import { Controller, Get, Version } from '@nestjs/common';
@Version('4')
@ApiTags({ name: 'reports' })
@Controller('reports')
export class ReportsController {
  @Get()
  public list() {}
}
`,
      // A second app whose prefix is read from config: no prefix is claimed for
      // it, and the other app's `/api` is not borrowed.
      'apps/admin/src/main.ts': `import { NestFactory } from '@nestjs/core';
async function bootstrap() {
  const app = await NestFactory.create(AdminModule);
  app.setGlobalPrefix(config.get('app.prefix'));
  app.enableVersioning({ defaultVersion: '1' });
  await app.listen(3334);
}
bootstrap();
`,
      'apps/admin/src/users.controller.ts': `import { Controller, Get } from '@nestjs/common';
@Controller('users')
export class UsersController {
  @Get()
  public list() {}
}
`,
    });
    try {
      expect(
        cg
          .getNodesByKind('route')
          .map((r) => r.name)
          .sort()
      ).toEqual(['GET /api/v1/stats/weekly', 'GET /api/v2/stats/daily', 'GET /api/v4/reports', 'GET /v1/users']);
    } finally {
      cg.close();
    }
  });

  it("connects a front end's request to the route it reaches, and leaves an Express route in the same repo alone", async () => {
    const cg = await project({
      'package.json': JSON.stringify({
        dependencies: { '@nestjs/core': '^11.0.0', '@nestjs/common': '^11.0.0', '@angular/core': '^19.0.0', express: '^4.0.0' },
      }),
      'apps/api/src/main.ts': MAIN,
      'apps/api/src/app/user.controller.ts': `import { Controller, Get } from '@nestjs/common';
@Controller('user')
export class UserController {
  @Get()
  public getUser() {}
}
`,
      'apps/client/src/app/user.service.ts': `import { HttpClient } from '@angular/common/http';
export class UserService {
  constructor(private http: HttpClient) {}
  public fetchUser() {
    return this.http.get<User>('/api/v1/user');
  }
}
`,
      'tools/mock-server/src/server.ts': `import express from 'express';
const app = express();
app.get('/status', (req, res) => res.json({ ok: true }));
`,
    });
    try {
      const names = cg.getNodesByKind('route').map((r) => r.name).sort();
      expect(names).toContain('GET /api/v1/user');
      expect(names).toContain('GET /status');
      const fetchUser = cg.getNodesByName('fetchUser')[0]!;
      const reached = cg
        .getOutgoingEdgesFrom([fetchUser.id], ['calls'])
        .filter((e) => (e.metadata as Record<string, unknown> | undefined)?.channel === 'http')
        .map((e) => cg.getNode(e.target)?.name);
      expect(reached).toEqual(['GET /api/v1/user']);
    } finally {
      cg.close();
    }
  });
});
