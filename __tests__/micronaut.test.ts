import { describe, it, expect } from 'vitest';
import { micronautResolver } from '../src/resolution/frameworks/micronaut';

describe('micronautResolver.extract', () => {
  it('extracts GET route with @Controller prefix and @Get annotation', () => {
    const src = `
package io.kestra.webserver.controllers.api;

import io.micronaut.http.annotation.Controller;
import io.micronaut.http.annotation.Get;

@Controller("/api/v1/executions")
public class ExecutionController {

    @Get(uri = "/search")
    public PagedResults<Execution> searchExecutions(
            @QueryValue String query) {
        return service.search(query);
    }
}
`;
    const { nodes, references } = micronautResolver.extract!('controllers/ExecutionController.java', src);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].kind).toBe('route');
    expect(nodes[0].name).toBe('GET /api/v1/executions/search');
    expect(references).toHaveLength(1);
    expect(references[0].referenceName).toBe('searchExecutions');
    expect(references[0].fromNodeId).toBe(nodes[0].id);
  });

  it('extracts route with bare string path (no uri= prefix)', () => {
    const src = `
@Controller("/api/users")
public class UserController {

    @Get("/{id}")
    public User getUser(@PathVariable Long id) {
        return repo.findById(id);
    }
}
`;
    const { nodes, references } = micronautResolver.extract!('controllers/UserController.java', src);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].name).toBe('GET /api/users/{id}');
    expect(references[0].referenceName).toBe('getUser');
  });

  it('extracts multiple routes from one controller', () => {
    const src = `
@Controller("/api/v1/flows")
public class FlowController {

    @Get("/search")
    public PagedResults<Flow> find(@QueryValue String q) {
        return service.find(q);
    }

    @Post
    public Flow create(@Body Flow flow) {
        return service.create(flow);
    }

    @Put("/{id}")
    public Flow update(@PathVariable String id, @Body Flow flow) {
        return service.update(id, flow);
    }

    @Delete("/{id}")
    public void delete(@PathVariable String id) {
        service.delete(id);
    }
}
`;
    const { nodes, references } = micronautResolver.extract!('controllers/FlowController.java', src);
    expect(nodes).toHaveLength(4);
    expect(nodes[0].name).toBe('GET /api/v1/flows/search');
    expect(nodes[1].name).toBe('POST /api/v1/flows');
    expect(nodes[2].name).toBe('PUT /api/v1/flows/{id}');
    expect(nodes[3].name).toBe('DELETE /api/v1/flows/{id}');
    expect(references.map(r => r.referenceName)).toEqual(['find', 'create', 'update', 'delete']);
  });

  it('extracts route with path template variables', () => {
    const src = `
@Controller("/api/v1/{tenant}/executions")
public class ExecutionController {

    @Post(uri = "/{id}/restart")
    public Execution restart(@PathVariable String tenant, @PathVariable String id) {
        return service.restart(id);
    }
}
`;
    const { nodes } = micronautResolver.extract!('controllers/ExecutionController.java', src);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].name).toBe('POST /api/v1/{tenant}/executions/{id}/restart');
  });

  it('handles @Get with no path (empty route inherits class prefix only)', () => {
    const src = `
@Controller("/health")
public class HealthController {

    @Get
    public String health() {
        return "OK";
    }
}
`;
    const { nodes, references } = micronautResolver.extract!('controllers/HealthController.java', src);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].name).toBe('GET /health');
    expect(references[0].referenceName).toBe('health');
  });

  it('handles controller with no class-level prefix', () => {
    const src = `
@Controller
public class RootController {

    @Get("/status")
    public String status() {
        return "up";
    }
}
`;
    const { nodes } = micronautResolver.extract!('controllers/RootController.java', src);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].name).toBe('GET /status');
  });

  it('extracts routes from Kotlin files', () => {
    const src = `
@Controller("/api/tasks")
class TaskController(private val service: TaskService) {

    @Get("/{id}")
    fun getTask(@PathVariable id: String): Task {
        return service.findById(id)
    }

    @Post
    fun createTask(@Body task: Task): Task {
        return service.create(task)
    }
}
`;
    const { nodes, references } = micronautResolver.extract!('controllers/TaskController.kt', src);
    expect(nodes).toHaveLength(2);
    expect(nodes[0].name).toBe('GET /api/tasks/{id}');
    expect(nodes[1].name).toBe('POST /api/tasks');
    expect(references[0].referenceName).toBe('getTask');
    expect(references[1].referenceName).toBe('createTask');
    expect(nodes[0].language).toBe('kotlin');
  });

  it('handles value= parameter syntax', () => {
    const src = `
@Controller("/api")
public class ApiController {

    @Get(value = "/info")
    public Info getInfo() {
        return new Info();
    }
}
`;
    const { nodes } = micronautResolver.extract!('controllers/ApiController.java', src);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].name).toBe('GET /api/info');
  });

  it('handles @Head and @Options verbs', () => {
    const src = `
@Controller("/api")
public class OptionsController {

    @Head("/ping")
    public void headPing() {}

    @Options("/cors")
    public void corsOptions() {}
}
`;
    const { nodes } = micronautResolver.extract!('controllers/OptionsController.java', src);
    expect(nodes).toHaveLength(2);
    expect(nodes[0].name).toBe('HEAD /api/ping');
    expect(nodes[1].name).toBe('OPTIONS /api/cors');
  });

  it('extracts @Client interface routes', () => {
    const src = `
@Client("/api/v1/users")
public interface UserClient {

    @Get("/{id}")
    User getById(@PathVariable String id);

    @Post
    User create(@Body User user);
}
`;
    const { nodes, references } = micronautResolver.extract!('client/UserClient.java', src);
    expect(nodes).toHaveLength(2);
    expect(nodes[0].name).toBe('GET /api/v1/users/{id}');
    expect(nodes[1].name).toBe('POST /api/v1/users');
    expect(references[0].referenceName).toBe('getById');
  });

  it('returns empty for non-Java/Kotlin files', () => {
    const { nodes, references } = micronautResolver.extract!('config/application.yml', 'micronaut.server.port: 8080');
    expect(nodes).toEqual([]);
    expect(references).toEqual([]);
  });

  it('handles @Patch annotation', () => {
    const src = `
@Controller("/api/items")
public class ItemController {

    @Patch("/{id}")
    public Item patchItem(@PathVariable String id, @Body Map<String, Object> updates) {
        return service.patch(id, updates);
    }
}
`;
    const { nodes } = micronautResolver.extract!('controllers/ItemController.java', src);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].name).toBe('PATCH /api/items/{id}');
  });

  it('handles @HttpMethodMapping for custom verbs', () => {
    const src = `
@Controller("/api/custom")
public class CustomController {

    @HttpMethodMapping("/action")
    public void customAction() {}
}
`;
    const { nodes } = micronautResolver.extract!('controllers/CustomController.java', src);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].name).toBe('ANY /api/custom/action');
  });
});

describe('micronautResolver.detect', () => {
  it('detects via pom.xml with io.micronaut', () => {
    const context = createMockContext({
      'pom.xml': '<dependency><groupId>io.micronaut</groupId></dependency>',
    });
    expect(micronautResolver.detect(context)).toBe(true);
  });

  it('detects via build.gradle with io.micronaut', () => {
    const context = createMockContext({
      'build.gradle': 'implementation "io.micronaut:micronaut-http-server-netty"',
    });
    expect(micronautResolver.detect(context)).toBe(true);
  });

  it('does not detect for Spring-only projects', () => {
    const context = createMockContext({
      'pom.xml': '<dependency><groupId>org.springframework.boot</groupId></dependency>',
    });
    expect(micronautResolver.detect(context)).toBe(false);
  });
});

function createMockContext(files: Record<string, string>) {
  return {
    readFile: (path: string) => files[path] ?? null,
    getAllFiles: () => Object.keys(files),
    getNodesByName: () => [],
    getNodesByQualifiedName: () => [],
    getNodesByKind: () => [],
    getNodesInFile: () => [],
    fileExists: (path: string) => path in files,
    getProjectRoot: () => '/project',
    getNodesByLowerName: () => [],
    getImportMappings: () => [],
  } as any;
}
