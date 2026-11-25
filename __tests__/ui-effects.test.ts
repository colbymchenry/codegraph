/**
 * The effects table (`src/ui-server/api/effects.ts`): what a call is when it
 * leaves the index, by the call as written, per language; the model and the
 * access a database call names; the status a response site sends.
 */
import { describe, it, expect } from 'vitest';
import { classifyEffect, implicitResponseStatus, responseStatus } from '../src/ui-server/api/effects';

const c = (text: string, language?: string, extra: Partial<Parameters<typeof classifyEffect>[0]> = {}) =>
  classifyEffect({ text, kind: 'calls', language: language as never, project: 'api', ...extra });
const n = (text: string, language?: string, extra: Partial<Parameters<typeof classifyEffect>[0]> = {}) =>
  classifyEffect({ text, kind: 'instantiates', language: language as never, project: 'api', ...extra });

describe('classifyEffect', () => {
  it('keeps the mobile app’s categories, with or without a language', () => {
    expect(c('client.post')?.category).toBe('network');
    expect(c('fetch', 'tsx')?.category).toBe('network');
    expect(c('AsyncStorage.setItem', 'tsx')?.category).toBe('storage');
    expect(c('Linking.openURL', 'tsx')?.category).toBe('device');
    expect(c('DdRum.addAction', 'tsx')?.category).toBe('telemetry');
    expect(c('Math.max', 'tsx')).toBeNull();
    expect(c('i18n.t', 'tsx')).toBeNull();
    expect(c('Object.create', 'typescript')).toBeNull();
  });

  it('TypeScript servers: the database by the chain, the model and the access', () => {
    expect(c('prisma.article.findFirst', 'typescript')).toEqual({ category: 'database', model: 'article', access: 'read' });
    expect(c('this.prisma.user.create', 'typescript')).toEqual({ category: 'database', model: 'user', access: 'write' });
    expect(c('this.usersRepository.save', 'typescript')).toEqual({ category: 'database', model: 'users', access: 'write' });
    expect(c('this.catModel.find', 'typescript')).toEqual({ category: 'database', model: 'cat', access: 'read' });
    expect(c('db.insert', 'typescript')).toEqual({ category: 'database', access: 'write' });
    expect(c('knex', 'typescript', { args: "'users'" })).toBeNull();
    expect(c('User.findOne', 'typescript')).toEqual({ category: 'database', model: 'User', access: 'read' });
    expect(c('Promise.all', 'typescript')).toBeNull();
  });

  it('TypeScript servers: responses, queues, email, payments, cache, auth', () => {
    expect(c('res.status(404).json', 'typescript')?.category).toBe('response');
    expect(c('res.json', 'typescript')?.category).toBe('response');
    expect(c('reply.code(201).send', 'typescript')?.category).toBe('response');
    expect(c('c.json', 'typescript')?.category).toBe('response');
    expect(n('NotFoundException', 'typescript')?.category).toBe('response');
    expect(n('UnprocessableEntityException', 'typescript')?.category).toBe('response');
    expect(n('HttpException', 'typescript')?.category).toBe('response');
    expect(n('Error', 'typescript')).toBeNull();
    expect(n('TypeError', 'typescript')).toBeNull();
    // In an app, an exception is an error, not a reply.
    expect(classifyEffect({ text: 'ValidationException', kind: 'instantiates', language: 'typescript', project: 'app' })).toBeNull();
    expect(c('this.emailQueue.add', 'typescript')?.category).toBe('queue');
    expect(c('queue.add', 'typescript')?.category).toBe('queue');
    expect(c('this.mailerService.sendMail', 'typescript')?.category).toBe('email');
    expect(c('resend.emails.send', 'typescript')?.category).toBe('email');
    expect(c('stripe.checkout.sessions.create', 'typescript')?.category).toBe('payments');
    expect(c('this.cacheManager.get', 'typescript')?.category).toBe('cache');
    expect(c('redis.setex', 'typescript')?.category).toBe('cache');
    expect(c('this.jwtService.signAsync', 'typescript')?.category).toBe('auth');
    expect(c('bcrypt.compare', 'typescript')?.category).toBe('auth');
    expect(c('jwt.verify', 'typescript')?.category).toBe('auth');
    expect(c('crypto.createHmac', 'typescript')?.category).toBe('auth');
    expect(c('crypto.createHash', 'typescript')).toBeNull();
    expect(c('crypto.randomBytes', 'typescript')).toBeNull();
    expect(c('s3.putObject', 'typescript')?.category).toBe('storage');
    expect(c('fs.writeFile', 'typescript')?.category).toBe('storage');
    expect(c('spawn', 'typescript')?.category).toBe('process');
    expect(c('process.exit', 'typescript')?.category).toBe('process');
  });

  it('Python: SQLAlchemy / Django, FastAPI / Flask / Django responses, celery, files, processes', () => {
    expect(c('session.exec', 'python')).toEqual({ category: 'database', access: 'read' });
    expect(c('session.add', 'python')).toEqual({ category: 'database', access: 'write' });
    expect(c('session.commit', 'python')).toEqual({ category: 'database', access: 'write' });
    expect(c('User.objects.filter', 'python')).toEqual({ category: 'database', model: 'User', access: 'read' });
    expect(c('db.session.add', 'python')?.category).toBe('database');
    expect(c('HTTPException', 'python')?.category).toBe('response');
    expect(c('JSONResponse', 'python')?.category).toBe('response');
    expect(c('jsonify', 'python')?.category).toBe('response');
    expect(c('abort', 'python')?.category).toBe('response');
    expect(c('render', 'python')?.category).toBe('response');
    expect(c('send_email.delay', 'python')?.category).toBe('queue');
    expect(c('send_mail', 'python')?.category).toBe('email');
    expect(c('requests.post', 'python')?.category).toBe('network');
    expect(c('httpx.AsyncClient', 'python')?.category).toBe('network');
    expect(c('open', 'python')?.category).toBe('storage');
    expect(c('s3.upload_file', 'python')?.category).toBe('storage');
    expect(c('subprocess.run', 'python')?.category).toBe('process');
    expect(c('jwt.encode', 'python')?.category).toBe('auth');
    expect(c('pwd_context.verify', 'python')?.category).toBe('auth');
    expect(c('print', 'python')).toBeNull();
    expect(c('len', 'python')).toBeNull();
    expect(c('item.model_dump', 'python')).toBeNull();
  });

  it('Java / Kotlin: repositories by name and by declared type, Spring responses, templates', () => {
    expect(c('owners.save', 'java', { receiverType: 'OwnerRepository' })).toEqual({ category: 'database', model: 'Owner', access: 'write' });
    expect(c('owners.findById', 'kotlin', { receiverType: 'OwnerRepository' })).toEqual({ category: 'database', model: 'Owner', access: 'read' });
    expect(c('this.ownerRepository.findAll', 'java')).toEqual({ category: 'database', model: 'owner', access: 'read' });
    expect(c('jdbcTemplate.update', 'java')?.category).toBe('database');
    expect(c('entityManager.persist', 'java')?.category).toBe('database');
    expect(c('ResponseEntity.ok', 'java')?.category).toBe('response');
    expect(c('ResponseEntity.status(HttpStatus.NOT_FOUND).body', 'java')?.category).toBe('response');
    expect(n('ResponseStatusException', 'java')?.category).toBe('response');
    expect(n('IllegalArgumentException', 'java')).toBeNull();
    expect(n('ResourceNotFoundException', 'java')?.category).toBe('response');
    expect(c('rabbitTemplate.convertAndSend', 'java')?.category).toBe('queue');
    expect(c('kafkaTemplate.send', 'java')?.category).toBe('queue');
    expect(c('applicationEventPublisher.publishEvent', 'java')?.category).toBe('queue');
    expect(c('mailSender.send', 'java')?.category).toBe('email');
    expect(c('restTemplate.getForObject', 'java')?.category).toBe('network');
    expect(c('webClient.get', 'java')?.category).toBe('network');
    expect(c('passwordEncoder.encode', 'java')?.category).toBe('auth');
    expect(c('redisTemplate.opsForValue', 'java')?.category).toBe('cache');
    expect(c('Files.write', 'java')?.category).toBe('storage');
    // Android: DataStore, SharedPreferences, Room DAOs, WorkManager.
    expect(c('userPreferences.updateData', 'kotlin')?.category).toBe('storage');
    expect(c('sharedPreferences.edit', 'kotlin')?.category).toBe('storage');
    expect(c('topicDao.upsertTopics', 'kotlin')).toEqual({ category: 'database', model: 'topic', access: 'write' });
    expect(c('workManager.enqueueUniqueWork', 'kotlin')?.category).toBe('queue');
    expect(c('viewModelScope.launch', 'kotlin')).toBeNull();
    expect(c('model.addAttribute', 'java')).toBeNull();
    expect(c('result.hasErrors', 'java')).toBeNull();
    expect(c('Objects.equals', 'java')).toBeNull();
  });

  it('C#: EF Core / repositories, controller responses, MassTransit, Identity', () => {
    expect(c('_context.TodoItems.Add', 'csharp')).toEqual({ category: 'database', model: 'TodoItems', access: 'write' });
    expect(c('_context.SaveChangesAsync', 'csharp')).toEqual({ category: 'database', access: 'write' });
    expect(c('_orderRepository.AddAsync', 'csharp')).toEqual({ category: 'database', model: 'order', access: 'write' });
    expect(c('_basketRepository.FirstOrDefaultAsync', 'csharp')).toEqual({ category: 'database', model: 'basket', access: 'read' });
    expect(c('NotFound', 'csharp')?.category).toBe('response');
    expect(c('Ok', 'csharp')?.category).toBe('response');
    expect(c('TypedResults.NoContent', 'csharp')?.category).toBe('response');
    expect(c('Results.Created', 'csharp')?.category).toBe('response');
    expect(n('NotFoundException', 'csharp')?.category).toBe('response');
    expect(n('ArgumentNullException', 'csharp')).toBeNull();
    expect(c('_bus.Publish', 'csharp')?.category).toBe('queue');
    expect(c('_publishEndpoint.Publish', 'csharp')?.category).toBe('queue');
    expect(c('BackgroundJob.Enqueue', 'csharp')?.category).toBe('queue');
    expect(c('_emailSender.SendEmailAsync', 'csharp')?.category).toBe('email');
    expect(c('_httpClient.GetAsync', 'csharp')?.category).toBe('network');
    expect(c('_userManager.CreateAsync', 'csharp')?.category).toBe('auth');
    expect(c('_signInManager.PasswordSignInAsync', 'csharp')?.category).toBe('auth');
    expect(c('_cache.GetOrCreateAsync', 'csharp')?.category).toBe('cache');
    expect(c('File.ReadAllText', 'csharp')?.category).toBe('storage');
    expect(c('Guard.Against.Null', 'csharp')).toBeNull();
    expect(c('nameof', 'csharp')).toBeNull();
    expect(c('sender.Send', 'csharp')).toBeNull();
  });

  it('Go: database/sql, gorm, gin responses, net/http, os', () => {
    expect(c('db.QueryRow', 'go')).toEqual({ category: 'database', access: 'read' });
    expect(c('db.Exec', 'go')).toEqual({ category: 'database', access: 'write' });
    expect(c('db.Create', 'go')?.category).toBe('database');
    expect(c('c.JSON', 'go')?.category).toBe('response');
    expect(c('c.AbortWithStatus', 'go')?.category).toBe('response');
    expect(c('http.Error', 'go')?.category).toBe('response');
    expect(c('w.WriteHeader', 'go')?.category).toBe('response');
    expect(c('http.Get', 'go')?.category).toBe('network');
    expect(c('client.Do', 'go')?.category).toBe('network');
    expect(c('os.ReadFile', 'go')?.category).toBe('storage');
    expect(c('exec.Command', 'go')?.category).toBe('process');
    expect(c('producer.Produce', 'go')?.category).toBe('queue');
    expect(c('jwt.NewWithClaims', 'go')?.category).toBe('auth');
    expect(c('fmt.Sprintf', 'go')).toBeNull();
    expect(c('errors.New', 'go')).toBeNull();
  });

  it('C: files, sockets, processes', () => {
    expect(c('fopen', 'c')?.category).toBe('storage');
    expect(c('fprintf', 'c')?.category).toBe('storage');
    expect(c('write', 'c')?.category).toBe('storage');
    expect(c('socket', 'c')?.category).toBe('network');
    expect(c('connect', 'c')?.category).toBe('network');
    expect(c('curl_easy_perform', 'c')?.category).toBe('network');
    expect(c('fork', 'c')?.category).toBe('process');
    expect(c('exit', 'c')?.category).toBe('process');
    expect(c('pthread_create', 'c')?.category).toBe('process');
    expect(c('strlen', 'c')).toBeNull();
    expect(c('malloc', 'c')).toBeNull();
    expect(c('memcpy', 'c')).toBeNull();
    expect(c('serverLog', 'c')).toBeNull();
  });

  it('Swift (Vapor), Ruby (Rails), PHP (Laravel)', () => {
    expect(c('Abort', 'swift')?.category).toBe('response');
    expect(c('Todo.query', 'swift')).toEqual({ category: 'database', model: 'Todo', access: 'read' });
    expect(c('todo.save', 'swift')?.category).toBe('database');
    expect(c('URLSession.shared.dataTask', 'swift')?.category).toBe('network');
    expect(c('render', 'ruby')?.category).toBe('response');
    expect(c('redirect_to', 'ruby')?.category).toBe('response');
    expect(c('User.find_by', 'ruby')).toEqual({ category: 'database', model: 'User', access: 'read' });
    expect(c('@user.save', 'ruby')?.category).toBe('database');
    expect(c('UserMailer.welcome', 'ruby')?.category).toBe('email');
    expect(c('HardJob.perform_later', 'ruby')?.category).toBe('queue');
    expect(c('User::find', 'php')).toEqual({ category: 'database', model: 'User', access: 'read' });
    expect(c('DB::table', 'php')?.category).toBe('database');
    expect(c('abort', 'php')?.category).toBe('response');
    expect(c('Mail::to', 'php')?.category).toBe('email');
  });

  it('a language without rows for a family stays quiet', () => {
    expect(c('foo.bar', 'ruby')).toBeNull();
    expect(c('save', 'python')).toBeNull();
    expect(c('render', 'java')).toBeNull();
  });
});

describe('responseStatus', () => {
  it('reads the literal code out of the chain, the arguments, or the name', () => {
    expect(responseStatus('res.status(404).json', '{ error }')).toBe(404);
    expect(responseStatus('res.status', '404')).toBe(404);
    expect(responseStatus('res.sendStatus', '204')).toBe(204);
    expect(responseStatus('res.json', '{ user }')).toBeNull();
    expect(responseStatus('reply.code(201).send', 'user')).toBe(201);
    expect(responseStatus('res.redirect', "'/login'")).toBe(302);
    expect(responseStatus('NotFoundException', "'no such user'", 'instantiates')).toBe(404);
    expect(responseStatus('UnprocessableEntityException', '{ errors }', 'instantiates')).toBe(422);
    expect(responseStatus('HttpException', "'x', HttpStatus.FORBIDDEN", 'instantiates')).toBe(403);
    expect(responseStatus('HttpException', "'x', 418", 'instantiates')).toBe(418);
    expect(responseStatus('HTTPException', 'status_code=404, detail="no title"')).toBe(404);
    expect(responseStatus('abort', '404')).toBe(404);
    expect(responseStatus('JsonResponse', '{ "error" }, status=400')).toBe(400);
    expect(responseStatus('Http404', '')).toBe(404);
    expect(responseStatus('ResponseEntity.ok', 'body')).toBe(200);
    expect(responseStatus('ResponseEntity.notFound().build', '')).toBe(404);
    expect(responseStatus('ResponseEntity.status(HttpStatus.CREATED).body', 'saved')).toBe(201);
    expect(responseStatus('ResponseStatusException', 'HttpStatus.NOT_FOUND, "x"', 'instantiates')).toBe(404);
    expect(responseStatus('ResponseEntity', 'body, HttpStatus.CREATED', 'instantiates')).toBe(201);
    expect(responseStatus('NotFound', '')).toBe(404);
    expect(responseStatus('Ok', 'item')).toBe(200);
    expect(responseStatus('CreatedAtAction', 'nameof(Get), item')).toBe(201);
    expect(responseStatus('TypedResults.NoContent', '')).toBe(204);
    expect(responseStatus('StatusCode', '500')).toBe(500);
    expect(responseStatus('Results.Problem', '')).toBe(500);
    expect(responseStatus('c.JSON', 'http.StatusCreated, u')).toBe(201);
    expect(responseStatus('c.String', '200, "ok"')).toBe(200);
    expect(responseStatus('http.Error', 'w, msg, http.StatusInternalServerError')).toBe(500);
    expect(responseStatus('w.WriteHeader', 'http.StatusNotFound')).toBe(404);
    expect(responseStatus('c.AbortWithStatus', '404')).toBe(404);
    expect(responseStatus('Abort', '.notFound')).toBe(404);
    expect(responseStatus('Abort', '.badRequest, reason: "x"')).toBe(400);
    expect(responseStatus('redirect_to', 'root_path')).toBe(302);
    expect(responseStatus('render', 'json: user, status: :created')).toBeNull();
    expect(responseStatus('res.status', 'code')).toBeNull();
    expect(responseStatus('res.json', '')).toBeNull();
  });
});

describe('implicitResponseStatus', () => {
  it('a body-sending reply that sets no status is a 200', () => {
    expect(implicitResponseStatus('res.json')).toBe(200);
    expect(implicitResponseStatus('res.send')).toBe(200);
    expect(implicitResponseStatus('res.render')).toBe(200);
    expect(implicitResponseStatus('reply.send')).toBe(200);
    expect(implicitResponseStatus('c.json')).toBe(200);
    expect(implicitResponseStatus('NextResponse.json')).toBe(200);
    expect(implicitResponseStatus('JSONResponse')).toBe(200);
    expect(implicitResponseStatus('jsonify')).toBe(200);
  });
  it('is null when the chain sets a status — literal or not — or ends without a body', () => {
    expect(implicitResponseStatus('res.status(404).json')).toBeNull();
    expect(implicitResponseStatus('res.status(code).json')).toBeNull();
    expect(implicitResponseStatus('res.sendStatus(204)')).toBeNull();
    expect(implicitResponseStatus('res.end')).toBeNull();
    expect(implicitResponseStatus('res.redirect')).toBeNull();
    expect(implicitResponseStatus('NotFoundException')).toBeNull();
    expect(implicitResponseStatus('prisma.user.create')).toBeNull();
  });
});
