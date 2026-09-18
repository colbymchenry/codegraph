/**
 * Effects — calls that leave the index and change something outside the
 * process — for the Steps view. A curated table, deliberately: "any call into
 * a package" is every `Date` and `Math.max`, and a box for each would bury
 * the ones that matter. Matched on the CALL AS WRITTEN — the whole member
 * chain read from the source at request time (`prisma.article.findFirst`,
 * `this.jwtService.signAsync`, `res.status(404).json`), because the index
 * keeps only the last segment of a deep chain — and, for a few families, on
 * the declared type of the receiver when the graph has it (`OwnerRepository
 * owners` → `owners.save` is the database).
 *
 * The categories are the reader's, not a library's: what a request sets in
 * motion is a database write, a response, a job on a queue, an email, a
 * charge, a cache read, a token check, a call to another service, a file, a
 * process. `response` is the endpoint's contract as the code has it — every
 * `res.status(404).json(…)`, `throw new NotFoundException(…)`,
 * `raise HTTPException(…)`, `ResponseEntity.notFound()` — and each site
 * carries the status code when it is literal.
 *
 * Language gates keep a rule from firing where it means something else: a
 * bare `open(…)` is a file in Python and nothing in particular in TypeScript;
 * `session.get` is the ORM in Python and a request in the browser. A rule
 * without a gate applies everywhere. Order matters — the first match wins —
 * so the specific rows sit above the general ones.
 */

import type { Language } from '../../types';

export type EffectCategory =
  | 'network'
  | 'storage'
  | 'device'
  | 'telemetry'
  | 'database'
  | 'response'
  | 'queue'
  | 'email'
  | 'payments'
  | 'cache'
  | 'auth'
  | 'process';

export type ProjectKind = 'app' | 'api' | 'web';

type Family = 'js' | 'py' | 'jvm' | 'cs' | 'go' | 'c' | 'rb' | 'php' | 'swift' | 'rs';

const FAMILIES: Record<Family, ReadonlySet<Language>> = {
  js: new Set<Language>(['javascript', 'typescript', 'tsx', 'jsx']),
  py: new Set<Language>(['python']),
  jvm: new Set<Language>(['java', 'kotlin', 'scala']),
  cs: new Set<Language>(['csharp']),
  go: new Set<Language>(['go']),
  c: new Set<Language>(['c', 'cpp', 'objc']),
  rb: new Set<Language>(['ruby']),
  php: new Set<Language>(['php']),
  swift: new Set<Language>(['swift']),
  rs: new Set<Language>(['rust']),
};

export interface EffectRule {
  category: EffectCategory;
  test: RegExp;
  /** Families the rule applies to; absent = every language. */
  only?: readonly Family[];
  /** Only for `new X(…)` / a constructor call. */
  instantiates?: boolean;
}

/** Built-in receivers a `Type.op` rule must never take for a model. */
const BUILTIN_RECEIVERS = /^(?:Object|Array|Promise|Date|Map|Set|WeakMap|WeakSet|Reflect|Buffer|JSON|Math|Number|String|Symbol|Error|BigInt|Intl|Atomics|Proxy|Function|Boolean|RegExp|globalThis|window|document|console|process|List|Dict|Optional|Collections|Arrays|Objects|Stream|Task|Enumerable|Convert|Guid|DateTime|TimeSpan|Path|Regex)$/;

const ORM_STATIC_OPS =
  '(?:find|findOne|findAll|findById|findByPk|findMany|findFirst|findUnique|findOrCreate|findAndCountAll|create|createMany|update|updateOne|updateMany|upsert|delete|deleteOne|deleteMany|destroy|save|insert|insertMany|aggregate|count|countDocuments|bulkCreate|bulkWrite|exists|distinct|where|query|all|first|last|pluck|find_by|find_each|find_or_create_by|create!|update!|destroy_all|delete_all|update_all|insert_all|upsert|includes|joins|order|limit|scope|select)';

/** A method that reads or writes a store — what makes `userModel.find` the database and `viewModel.load` nothing. */
const DB_OP =
  '(?:find\\w*|get|getOne|getMany|getAll|getById|count\\w*|aggregate|create\\w*|update\\w*|upsert|delete\\w*|remove\\w*|save\\w*|insert\\w*|exists|query\\w*|execute\\w*|exec|raw|persist|merge|flush|first\\w*|last\\w*|all|any\\w*|toList\\w*|toArray\\w*|select\\w*|where|orderBy|distinct|paginate|truncate|drop|Add\\w*|Remove\\w*|Update\\w*|Find\\w*|First\\w*|Single\\w*|ToList\\w*|Count\\w*|Any\\w*|Create|Save|Delete|Where|Get|Select|Query\\w*|Exec\\w*|InsertOne|InsertMany|FindOne|UpdateOne|DeleteOne|DeleteMany|ReplaceOne|CountDocuments|bulk\\w*|batch\\w*)';

/** The table. Order matters: first match wins. */
export const EFFECT_RULES: ReadonlyArray<EffectRule> = [
  // ---------------------------------------------------------------- response --
  {
    category: 'response',
    test: /^(?:res|response|reply|rep|ctx|c|context)(?:\.(?:status|sendStatus|code|type|header|headers|set|append|cookie|clearCookie|vary|location|links|format))*\.(?:status|json|jsonp|send|sendStatus|end|redirect|render|sendFile|download|attachment|write|writeHead|code|type|header|set|cookie|body|text|html|notFound|stream|file|view|throw|assert)$/,
    only: ['js'],
  },
  { category: 'response', test: /^(?:NextResponse|Response)\.(?:json|redirect|rewrite|next|error)$|^(?:createError|createHttpError|httpErrors\.\w+|Boom\.\w+|boom\.\w+|HttpError|HTTPError)$/, only: ['js'] },
  { category: 'response', test: /^(?:NextResponse|Response)$/, only: ['js'], instantiates: true },
  {
    category: 'response',
    test: /^(?:HTTPException|JSONResponse|Response|RedirectResponse|StreamingResponse|FileResponse|HTMLResponse|PlainTextResponse|ORJSONResponse|jsonify|abort|make_response|redirect|render_template|send_file|send_from_directory|JsonResponse|HttpResponse|HttpResponseRedirect|HttpResponsePermanentRedirect|HttpResponseNotFound|HttpResponseBadRequest|HttpResponseForbidden|HttpResponseNotAllowed|HttpResponseServerError|Http404|render|get_object_or_404|get_list_or_404|NotFound|PermissionDenied|ValidationError|AuthenticationFailed|NotAuthenticated|ParseError|MethodNotAllowed|Throttled|APIException|status\.HTTP_\w+)$/,
    only: ['py'],
  },
  { category: 'response', test: /^ResponseEntity(?:\.\w+)*$|^ResponseStatusException$|^(?:ServerResponse|Mono\.just\(ResponseEntity)/, only: ['jvm'] },
  {
    category: 'response',
    test: /^(?:Ok|NotFound|BadRequest|Created|CreatedAtAction|CreatedAtRoute|NoContent|Unauthorized|Forbid|Accepted|AcceptedAtAction|Problem|StatusCode|Conflict|UnprocessableEntity|Redirect|RedirectPermanent|RedirectToAction|RedirectToPage|RedirectToRoute|LocalRedirect|View|PartialView|Json|File|PhysicalFile|Content|Challenge|SignIn|SignOut|ValidationProblem|Page)$|^(?:Results|TypedResults)\.\w+$|^(?:Response|HttpContext\.Response)\.(?:WriteAsync|WriteAsJsonAsync|Redirect|StatusCode)$/,
    only: ['cs'],
  },
  {
    category: 'response',
    test: /^(?:c|ctx|g)\.(?:JSON|IndentedJSON|PureJSON|AsciiJSON|SecureJSON|JSONP|XML|YAML|TOML|ProtoBuf|String|HTML|Data|DataFromReader|File|FileAttachment|Redirect|Render|Status|AbortWithStatus|AbortWithStatusJSON|AbortWithError|Abort|Error|SendString|SendStatus|Send|Blob|Stream|NoContent|Attachment|Format)$|^http\.(?:Error|Redirect|NotFound|ServeFile|ServeContent)$|^(?:w|rw|res|writer)\.(?:WriteHeader|Write|Header)$|^(?:render|json|xml)\.\w+$/,
    only: ['go'],
  },
  { category: 'response', test: /^(?:Abort|Response|HTTPStatus\.\w+|req\.redirect|request\.redirect)$/, only: ['swift'] },
  { category: 'response', test: /^(?:render|redirect_to|redirect_back|head|respond_to|respond_with|send_data|send_file|render_to_string)$/, only: ['rb'] },
  { category: 'response', test: /^(?:response|abort|abort_if|abort_unless|redirect|view|back|json)(?:\(\)->\w+)?$/, only: ['php'] },
  { category: 'response', test: /^(?:HttpResponse|Json|StatusCode|Redirect|NamedFile|HttpResponseBuilder)(?:::\w+)*$/, only: ['rs'] },

  // ---------------------------------------------------------------- database --
  { category: 'database', test: /^(?:this\.)?(?:prisma|db|database|orm|em|entityManager|dataSource|queryRunner|knex|kysely|sequelize|mongoose|drizzle|sql|pool|pg|pgClient|conn|connection|repo|repository|collection|trx|tx|typeorm|dbClient|mongo|mongoClient)\.(?:\w+\.)?\$?\w+$/, only: ['js'] },
  { category: 'database', test: /^(?:this\.)?_?\w*(?:Repository|Repo|Dao|DAO|Mapper|EntityManager|DataSource|Knex|Prisma|Kysely|Drizzle|Sequelize|DbContext|DbSet)\.(?:\w+\.)?\w+$/, only: ['js', 'jvm', 'cs', 'go', 'rs', 'swift', 'rb'] },
  { category: 'database', test: new RegExp(`^(?:this\\.)?_?\\w*(?:Model|Entity|Collection|Table|Db|DB|Database|Datastore)\\.(?:\\w+\\.)?${DB_OP}$`), only: ['js', 'jvm', 'cs', 'go', 'rs', 'swift', 'rb'] },
  { category: 'database', test: new RegExp(`^(?!${BUILTIN_RECEIVERS.source.slice(1, -1)}\\b)[A-Z]\\w*\\.${ORM_STATIC_OPS}$`), only: ['js', 'rb', 'swift', 'php'] },
  { category: 'database', test: /^(?:self\.)?(?:\w*_)?(?:session|db|database|engine|cursor|conn|connection|Session)\.(?:session\.)?(?:query|add|add_all|commit|execute|executemany|exec|delete|refresh|flush|rollback|get|merge|scalars?|scalar_one\w*|one|one_or_none|first|all|begin|close|expunge|bulk_\w+|select|insert|update|fetchone|fetchall|fetchmany|create_all|drop_all|run_sync)$/, only: ['py'] },
  { category: 'database', test: /^[A-Z]\w*\.(?:objects|query|_default_manager)(?:\.\w+)*$|^\w+\.objects\.\w+$|^(?:select|insert|update|delete|text|func\.\w+|bulk_create|bulk_update|get_object_or_404)$|^\w+\.(?:save|delete|refresh_from_db|get_or_create|update_or_create|filter|exclude|annotate|aggregate|values|values_list|select_related|prefetch_related|bulk_create|bulk_update|create|update|count|exists)$/, only: ['py'] },
  { category: 'database', test: /^(?:this\.)?(?:\w*[rR]epository|\w*[rR]epo|\w*Dao|\w*DAO|\w*Mapper|jdbcTemplate|namedParameterJdbcTemplate|jdbc|entityManager|em|session|sessionFactory|mongoTemplate|mongoOperations|r2dbcEntityTemplate|databaseClient|criteriaBuilder|query|typedQuery|nativeQuery|jpaRepository|crudRepository|dsl|dslContext|create|template)\.(?:\w+\.)*\w+$/, only: ['jvm'] },
  { category: 'database', test: /^(?:this\.)?_?(?:\w*[rR]epository|\w*[rR]epo|\w*Dao|\w*[cC]ontext|dbContext|db|_db|_context|connection|_connection|conn|_conn|collection|_collection|session|_session|unitOfWork|_unitOfWork|uow|_uow|dbSet|_dbSet)\.(?:\w+\.)*\w+$/, only: ['cs'] },
  { category: 'database', test: /\.(?:SaveChanges|SaveChangesAsync|ToListAsync|ToArrayAsync|FirstOrDefaultAsync|SingleOrDefaultAsync|FirstAsync|SingleAsync|AnyAsync|CountAsync|ExecuteUpdateAsync|ExecuteDeleteAsync|ExecuteSqlRawAsync|ExecuteSqlAsync|FromSqlRaw|FromSql|AddAsync|AddRangeAsync|FindAsync|QueryAsync|QueryFirstOrDefaultAsync|QuerySingleAsync|ExecuteAsync|ExecuteScalarAsync|InsertOneAsync|InsertManyAsync|ReplaceOneAsync|UpdateOneAsync|DeleteOneAsync|DeleteManyAsync)$/, only: ['cs'] },
  { category: 'database', test: /^(?:db|DB|tx|conn|pool|dbConn|client|repo|store|coll|collection|session|s\.db|r\.db|h\.db|s\.DB|h\.DB|a\.db|app\.db|q|queries|s\.queries|gorm|sqlx|dbx)\.(?:\w+\.)*(?:Query\w*|Exec\w*|Prepare\w*|Begin\w*|Create|First|Find|Save|Delete|Where|Updates?|Model|Table|Raw|Scan|Get|Select|NamedExec|InsertOne|InsertMany|FindOne|UpdateOne|UpdateMany|DeleteOne|DeleteMany|ReplaceOne|CountDocuments|Count|Take|Last|Preload|Joins|Order|Limit|Offset|Transaction|AutoMigrate|Migrate|Insert|Update|Upsert|Aggregate|Distinct|Pluck|Rows|Row|Set|Get\w+|List\w+|Create\w+|Update\w+|Delete\w+)$/, only: ['go'] },
  { category: 'database', test: /^[A-Z]\w*\.(?:query|find|create|all|first|last|save|delete|update)$|^\w+\.(?:save|create|delete|update|query)$|^(?:req|request)\.db\.\w+$/, only: ['swift'] },
  { category: 'database', test: /^(?:@?\w+)\.(?:save|save!|update|update!|update_attributes|destroy|destroy!|reload|touch|increment!|decrement!)$|^ActiveRecord::Base\.\w+$|^\w+\.(?:where|find|find_by|find_each|first|last|all|create|create!|pluck|count|exists\?|order|includes|joins|delete_all|update_all|insert_all|upsert_all|find_or_create_by)$/, only: ['rb'] },
  { category: 'database', test: /^[A-Z]\w*::(?:find|findOrFail|findMany|create|firstOrCreate|updateOrCreate|where|whereIn|all|first|firstOrFail|query|insert|update|destroy|truncate|count|with|select|orderBy|paginate)$|^DB::\w+$|^\$\w+->(?:save|delete|update|create|fill|refresh|forceDelete|restore|increment|decrement|touch)$/, only: ['php'] },
  { category: 'database', test: /^(?:sqlx|diesel|sea_orm|mongodb)(?:::\w+)*$|^\w+(?:::\w+)*::(?:find|find_by_id|insert|update|delete|save|find_many|find_one|filter)$|^(?:conn|pool|tx|db|client)\.(?:execute|query\w*|prepare|begin|commit|rollback|fetch\w*)$/, only: ['rs'] },
  { category: 'database', test: /^(?:sqlite3_\w+|mysql_\w+|PQ\w+|SQLExec\w*|SQLPrepare|SQLFetch\w*|redis\w*Command|mongoc_\w+)$/, only: ['c'] },

  // ------------------------------------------------------------------- queue --
  { category: 'queue', test: /^(?:this\.)?(?:\w*[qQ]ueue\w*)\.(?:add|addBulk|process|createJob|send|sendMessage|publish|push|enqueue)$|^(?:this\.)?(?:sqs|sqsClient|sns|snsClient|pubsub|topic|producer|kafka|kafkaProducer|rabbit|channel|amqp|nats|nc|eventBridge|bus|messageBus|eventBus|agenda|boss|pgBoss|inngest|trigger|client\.queue)\.(?:\w+\.)*(?:send|sendMessage|sendMessageBatch|publish|publishMessage|produce|emit|add|schedule|now|enqueue|sendToQueue|put|dispatch|trigger|createJob|createSchedule|invoke|batch)$|^(?:agenda|boss|pgBoss|inngest)\.\w+$/, only: ['js'] },
  { category: 'queue', test: /^(?:SendMessageCommand|PublishCommand|PutEventsCommand|SendMessageBatchCommand|InvokeCommand)$/, only: ['js'], instantiates: true },
  { category: 'queue', test: /^\w+\.(?:delay|apply_async|send_task|si|s|enqueue|enqueue_call|enqueue_in|enqueue_at|send_message|send_message_batch|basic_publish|publish|produce|put_events|invoke)$|^(?:celery|app|current_app)\.send_task$|^(?:sqs|sns|producer|channel|queue|q|redis_queue|dramatiq|huey)\.\w+$/, only: ['py'] },
  { category: 'queue', test: /^(?:this\.)?(?:\w*[tT]emplate|\w*[pP]ublisher|\w*[pP]roducer|\w*[qQ]ueue\w*|sqsClient|snsClient|amazonSQS|amazonSNS|eventBus|messageBus|bus|channel|rabbitTemplate|kafkaTemplate|jmsTemplate|streamBridge|eventPublisher|applicationEventPublisher)\.(?:send\w*|convertAndSend|publish\w*|publishEvent|produce|sendMessage|put\w*|emit|dispatch|enqueue)$/, only: ['jvm'] },
  { category: 'queue', test: /^(?:this\.)?_?(?:bus|publishEndpoint|sendEndpoint|producer|queue\w*|channel|messageSession|serviceBus|serviceBusSender|topicClient|queueClient|eventGrid|BackgroundJob|RecurringJob|BackgroundJobClient|jobClient|_jobs|jobs)\.(?:\w+\.)*(?:Publish\w*|Send\w*|Produce\w*|Enqueue\w*|Schedule\w*|AddOrUpdate|BasicPublish|SendMessageAsync|SendMessagesAsync|Create\w*Message|Dispatch\w*|Trigger\w*)$/, only: ['cs'] },
  { category: 'queue', test: /^(?:\w+\.)*(?:Publish|PublishMsg|PublishAsync|SendMessage|SendMessageWithContext|Produce|ProduceSync|Enqueue|EnqueueContext|PutEvents|WriteMessages|Emit|Dispatch|Schedule|SendMsg)$/, only: ['go'] },
  { category: 'queue', test: /^\w+\.(?:perform_later|perform_async|perform_in|perform_at|deliver_later|set|publish|enqueue)$|^Sidekiq::Client\.\w+$/, only: ['rb'] },
  { category: 'queue', test: /^(?:dispatch|dispatch_now|dispatch_sync|Queue::\w+|Bus::\w+|Event::dispatch|event|broadcast)$|^\w+::dispatch(?:Sync|Now|AfterResponse)?$|^\$\w+->dispatch$/, only: ['php'] },

  // ------------------------------------------------------------------- email --
  { category: 'email', test: /^(?:this\.)?(?:\w*[mM]ail\w*|\w*[tT]ransporter|sgMail|sendgrid|resend|mailgun|postmark|ses|sesClient|sesv2|smtp|nodemailer|courier|brevo|sendinblue|mailjet|mandrill|loops|plunk)\.(?:\w+\.)*(?:send\w*|sendMail|sendEmail|sendTemplate|create|deliver|emails\.send|transactional\w*)$|^(?:SendEmailCommand|SendTemplatedEmailCommand|SendRawEmailCommand)$/, only: ['js'] },
  { category: 'email', test: /^(?:send_mail|send_mass_mail|mail_admins|mail_managers|EmailMessage|EmailMultiAlternatives|mail\.send|mail\.send_message|smtplib\.SMTP|smtplib\.SMTP_SSL|ses\.send_email|ses\.send_raw_email|sg\.send|sendgrid\.\w+|resend\.Emails\.send|postmark\.\w+)$|^\w+\.send_(?:email|mail|message)$|^(?:smtp|server|mailer|email_client)\.(?:sendmail|send_message|send|login|starttls)$/, only: ['py'] },
  { category: 'email', test: /^(?:this\.)?(?:\w*[mM]ailSender|\w*[mM]ailer|mailService|emailService|sesClient|amazonSimpleEmailService|transport|Transport)\.(?:send\w*|deliver)$|^Transport\.send$/, only: ['jvm'] },
  { category: 'email', test: /^(?:this\.)?_?(?:emailSender|emailService|mailService|mailer|smtpClient|sendGridClient|sesClient|fluentEmail|email)\.(?:Send\w*)$|^Email\.(?:From|Send\w*)$/, only: ['cs'] },
  { category: 'email', test: /^(?:smtp\.SendMail|mail\.Send\w*|\w+\.SendEmail\w*|\w+\.SendMail|ses\.SendEmail|sg\.Send|mg\.Send)$/, only: ['go'] },
  { category: 'email', test: /^\w+Mailer\.\w+$|^\w+\.(?:deliver_now|deliver_later|deliver)$|^Mail\.deliver$/, only: ['rb'] },
  { category: 'email', test: /^Mail::(?:to|send|raw|queue|bcc|cc)$|^Notification::send$|^\$\w+->notify$/, only: ['php'] },

  // ---------------------------------------------------------------- payments --
  { category: 'payments', test: /^(?:this\.)?(?:stripe|Stripe|braintree|paypal|PayPal|square|razorpay|paddle|Paddle|adyen|mollie|chargebee|recurly|lemonSqueezy|lemonsqueezy|checkout|gateway|paymentGateway|paymentsClient|paymentService|_paymentService|stripeClient|stripeService|_stripe)\b/ },

  // ------------------------------------------------------------------- cache --
  { category: 'cache', test: /^(?:this\.)?(?:redis|redisClient|ioredis|cache|cacheManager|cacheService|memcached|memcache|kv|KV|upstash|_cache|_distributedCache|_memoryCache|distributedCache|memoryCache|redisTemplate|stringRedisTemplate|jedis|lettuce|redisson|rdb|rc|cacheClient|caches|Cache|env\.\w*KV\w*)\.(?:\w+\.)*(?:get\w*|set\w*|del\w*|delete\w*|remove\w*|incr\w*|decr\w*|expire\w*|exists|has|hget\w*|hset\w*|hdel|hgetall|lpush|rpush|lpop|rpop|sadd|srem|smembers|zadd|zrange\w*|zrem|wrap|mget|mset|setex|setnx|ttl|keys|flush\w*|reset|clear|store|put\w*|evict|invalidate\w*|GetOrCreate\w*|GetString\w*|SetString\w*|GetOrSet\w*|Refresh\w*|Get|Set|Del|Delete|Exists|Expire|Incr|Decr|HGet\w*|HSet\w*|Publish|Subscribe|TryGetValue|CreateEntry|opsForValue|opsForHash|opsForList|opsForSet|Fetch|fetch|read|write|delete_pattern|delete_many|get_many|set_many|touch|add|remember|rememberForever|forget|pull|increment|decrement|forever|tags|memoize)$/ },

  // -------------------------------------------------------------------- auth --
  { category: 'auth', test: /^(?:this\.)?(?:jwt|jsonwebtoken|jose|SignJWT|jwtVerify|bcrypt|bcryptjs|argon2|scrypt|passport|jwtService|_jwtService|tokenService|authService\.sign\w*|auth\.api|auth\.\w+|betterAuth|clerk|clerkClient|supabase\.auth|firebase\.auth|admin\.auth|getAuth|getServerSession|getSession|auth|lucia|nextauth|NextAuth|verifyIdToken|verifyToken|signToken|createSession|invalidateSession|oauth2|OAuth2Client|okta|auth0|cognito|CognitoIdentityServiceProvider|Keychain|crypto\.timingSafeEqual|crypto\.pbkdf2\w*|crypto\.scrypt\w*|crypto\.createHmac)\b(?:\.(?:\w+\.)*\w+)?$/, only: ['js'] },
  { category: 'auth', test: /^(?:jwt|pyjwt|jose|bcrypt|argon2|passlib|pwd_context|password_hasher|hashers|check_password|make_password|authenticate|login|logout|login_required|get_user|verify_password|get_password_hash|create_access_token|create_refresh_token|decode_token|OAuth2PasswordBearer|HTTPBearer|HTTPBasic|Depends\(get_current_user\)|secrets\.\w+|hmac\.\w+|hashlib\.\w+|itsdangerous|serializer\.dumps|serializer\.loads|token_urlsafe|oauth|authlib|social_core|allauth)(?:\.(?:\w+\.)*\w+)?$/, only: ['py'] },
  { category: 'auth', test: /^(?:this\.)?(?:passwordEncoder|bCryptPasswordEncoder|encoder|jwtUtil\w*|jwtService|jwtProvider|tokenProvider|tokenService|jwtDecoder|jwtEncoder|Jwts|JWT|Jwt|authenticationManager|authManager|SecurityContextHolder|securityContext|userDetailsService|BCrypt|Keys|Algorithm|Argon2\w*|SCrypt\w*|Pbkdf2\w*|MessageDigest|Mac|SecureRandom|keycloak|oauth2\w*|OAuth2\w*|clientRegistrationRepository|authorizedClientService)\.(?:\w+\.)*\w+$/, only: ['jvm'] },
  { category: 'auth', test: /^(?:this\.)?_?(?:userManager|signInManager|roleManager|tokenHandler|jwtHandler|JwtSecurityTokenHandler|tokenService|jwtService|authService|authenticationService|passwordHasher|PasswordHasher|HttpContext\.SignInAsync|HttpContext\.SignOutAsync|HttpContext\.AuthenticateAsync|HttpContext\.ChallengeAsync|context\.SignInAsync|context\.SignOutAsync|identityService|_identityService|currentUser|_currentUser|user\.Identity|User\.Identity|User\.Claims|User\.IsInRole|BCrypt|Argon2|Rfc2898DeriveBytes|RandomNumberGenerator|SHA256|HMACSHA256|KeyDerivation|Convert\.ToBase64String)\.(?:\w+\.)*\w+$|^(?:JwtSecurityToken|JwtSecurityTokenHandler|SymmetricSecurityKey|SigningCredentials|ClaimsIdentity|ClaimsPrincipal|AuthenticationProperties)$/, only: ['cs'] },
  { category: 'auth', test: /^(?:jwt|jose|paseto|bcrypt|argon2|scrypt|pbkdf2|hmac|sha256|oauth2|oidc|auth|authz|casbin|token|session|sessions|securecookie|gothic|goth)\.(?:\w+\.)*\w+$|^\w+\.(?:SignedString|ParseWithClaims|GenerateFromPassword|CompareHashAndPassword|Verify|VerifyToken|GenerateToken|ValidateToken|Authenticate|Authorize|Login|Logout|CheckPassword|HashPassword)$/, only: ['go'] },
  { category: 'auth', test: /^(?:BCrypt::Password\.\w+|JWT\.(?:encode|decode)|sign_in|sign_out|sign_in_and_redirect|authenticate_user!|authenticate_with_http_token|authenticate_or_request_with_http_basic|current_user|has_secure_password|Devise\.\w+|warden\.\w+|OmniAuth\.\w+|Doorkeeper\.\w+|SecureRandom\.\w+|Digest::\w+\.\w+)$|^\w+\.(?:authenticate|authenticate!|regenerate_token|generate_token|valid_password\?)$/, only: ['rb'] },
  { category: 'auth', test: /^(?:Auth::\w+|Hash::\w+|Password::\w+|Crypt::\w+|Gate::\w+|Socialite::\w+|Passport::\w+|Sanctum::\w+|JWTAuth::\w+|password_hash|password_verify|\$request->user|\$user->createToken|\$user->tokens)(?:\(\)->\w+)*$/, only: ['php'] },
  { category: 'auth', test: /^(?:jsonwebtoken|bcrypt|argon2|scrypt|pbkdf2|hmac|sha2|ring|rustls|oauth2|openidconnect|jwt_simple|biscuit|paseto)(?:::\w+)*$/, only: ['rs'] },
  { category: 'auth', test: /^(?:crypt|getpwnam|getpwuid|setuid|setgid|seteuid|PAM_\w+|pam_\w+|SSL_CTX_\w+|EVP_\w+|HMAC|RAND_bytes|BN_\w+|X509_\w+|gnutls_\w+)$/, only: ['c'] },

  // ----------------------------------------------------------------- storage --
  { category: 'storage', test: /^(?:AsyncStorage|SecureStore|MMKV|localStorage|sessionStorage|indexedDB|UserDefaults|Keychain|KeychainAccess|FileSystem|RNFS|FileManager|fs|fsp|fs\.promises|promises|path\.write|Deno\.(?:writeFile|readFile|writeTextFile|readTextFile|remove|mkdir|open|create|stat)|Bun\.(?:write|file))\b/ },
  { category: 'storage', test: /^(?:this\.)?(?:s3|s3Client|S3|storage|bucket|gcs|blob|blobClient|blobService|containerClient|cloudinary|uploader|uploadthing|utapi|supabase\.storage|firebase\.storage|storageRef|ref|getStorage|minio|minioClient|r2|R2|env\.\w*(?:BUCKET|R2)\w*|sharp|multer)\.(?:\w+\.)*(?:putObject|getObject|deleteObject|listObjects\w*|upload\w*|download\w*|send|file|save|delete|remove|getSignedUrl|createSignedUrl|createReadStream|createWriteStream|put|get|head|copy|move|exists|list|write\w*|read\w*|toFile|toBuffer|from|upload_stream|destroy|createPresignedPost|presign\w*|bucket|object)$|^(?:PutObjectCommand|GetObjectCommand|DeleteObjectCommand|CopyObjectCommand|HeadObjectCommand|ListObjectsV2Command|CreateMultipartUploadCommand|UploadPartCommand|Upload)$/, only: ['js'] },
  { category: 'storage', test: /^(?:open|os\.(?:remove|unlink|rename|replace|makedirs|mkdir|rmdir|removedirs|listdir|scandir|walk|chmod|chown|stat|path\.exists|path\.isfile|path\.isdir|path\.getsize|symlink|link|truncate|utime|fsync)|shutil\.\w+|tempfile\.\w+|Path\(\w*\)\.(?:write_text|write_bytes|read_text|read_bytes|unlink|mkdir|rmdir|rename|replace|touch|exists|iterdir|glob|rglob|open)|\w+\.(?:write_text|write_bytes|read_text|read_bytes|unlink|mkdir|rmdir|touch)|boto3\.(?:client|resource)|s3\.(?:upload_file|upload_fileobj|download_file|download_fileobj|put_object|get_object|delete_object|list_objects\w*|head_object|copy_object|generate_presigned_url|create_bucket)|s3_client\.\w+|bucket\.(?:upload_file|download_file|put_object|delete_objects|objects)|default_storage\.\w+|storage\.\w+|FileSystemStorage|blob\.(?:upload_from_\w+|download_as_\w+|download_to_\w+|delete|exists)|bucket\.blob|gcs\.\w+|blob_client\.\w+|container_client\.\w+|json\.dump|pickle\.dump|pickle\.load|json\.load|csv\.writer|csv\.reader|zipfile\.ZipFile|tarfile\.open|gzip\.open|aiofiles\.open|anyio\.open_file|shelve\.open|sqlite3\.connect|dbm\.open)$/, only: ['py'] },
  { category: 'storage', test: /^(?:this\.)?(?:\w*[dD]ataStore|\w*[pP]references|\w*[pP]refs|sharedPreferences|prefs|editor)\.(?:updateData|edit|data|apply|commit|getString|putString|getInt|putInt|getLong|putLong|getBoolean|putBoolean|getFloat|putFloat|getStringSet|putStringSet|remove|clear|contains)$|^(?:this\.)?(?:context|applicationContext|appContext|ctx)\.(?:openFileOutput|openFileInput|getSharedPreferences|deleteFile|getFilesDir|getCacheDir|getExternalFilesDir|getDatabasePath|deleteDatabase|contentResolver\.\w+)$|^(?:this\.)?(?:contentResolver|resolver)\.(?:query|insert|update|delete|openInputStream|openOutputStream)$/, only: ['jvm'] },
  { category: 'queue', test: /^(?:this\.)?(?:\w*[wW]orkManager|\w*[sS]cheduler|jobScheduler|alarmManager|\w*AlarmManager)\.(?:enqueue\w*|beginWith|beginUniqueWork|cancel\w*|schedule\w*|set\w*|setExact\w*|setRepeating|setInexactRepeating)$/, only: ['jvm'] },
  { category: 'storage', test: /^(?:Files|Paths|File|FileUtils|IOUtils|FileSystems|Channels|FileChannel)\.\w+$|^(?:this\.)?(?:s3Client|amazonS3|s3|storage|gcsStorage|blobClient|blobServiceClient|containerClient|minioClient|storageService|fileService|fileStorage|resourceLoader|resource)\.(?:\w+\.)*\w+$|^(?:FileInputStream|FileOutputStream|FileReader|FileWriter|RandomAccessFile|BufferedWriter|BufferedReader|PrintWriter|PutObjectRequest|GetObjectRequest|DeleteObjectRequest|ObjectMetadata)$/, only: ['jvm'] },
  { category: 'storage', test: /^(?:File|Directory|Path\.(?:Combine)?|FileInfo|DirectoryInfo|FileStream|StreamWriter|StreamReader|BinaryWriter|BinaryReader|ZipFile|ZipArchive|IsolatedStorageFile)(?:\.\w+)*$|^(?:this\.)?_?(?:s3Client|blobClient|blobServiceClient|containerClient|blobContainer|storage|storageService|fileStorage|fileService|fileProvider|_fileProvider|amazonS3|minio|minioClient)\.(?:\w+\.)*\w+$|^(?:FileStream|StreamWriter|StreamReader|BinaryWriter|BinaryReader|PutObjectRequest|GetObjectRequest|DeleteObjectRequest|TransferUtility)$/, only: ['cs'] },
  { category: 'storage', test: /^(?:os|ioutil|io|filepath|bufio|afero|fs)\.(?:Open|OpenFile|Create|CreateTemp|ReadFile|WriteFile|Remove|RemoveAll|MkdirAll|Mkdir|MkdirTemp|Rename|Stat|Lstat|ReadDir|Chmod|Chown|Truncate|Symlink|Link|Readlink|Copy|CopyN|WriteString|Walk|WalkDir|Glob|NewWriter|NewReader|TempDir|TempFile|ReadAll)$|^(?:f|file|fd|w|writer)\.(?:Write\w*|Read\w*|Close|Sync|Seek|Truncate|WriteString)$|^(?:s3|s3Client|svc|uploader|downloader|storage|bucket|client|minioClient|blob)\.(?:PutObject\w*|GetObject\w*|DeleteObject\w*|ListObjects\w*|HeadObject\w*|CopyObject\w*|Upload\w*|Download\w*|Object|Bucket|Write|NewWriter|NewReader|FPutObject|FGetObject|PresignedGetObject|PresignedPutObject)$/, only: ['go'] },
  { category: 'storage', test: /^(?:fopen|freopen|fclose|fread|fwrite|fgets|fputs|fgetc|fputc|fscanf|fprintf|fflush|fseek|ftell|rewind|open|openat|creat|close|read|write|pread|pwrite|lseek|unlink|unlinkat|remove|rename|renameat|mkdir|mkdirat|rmdir|stat|fstat|lstat|fstatat|access|chmod|fchmod|chown|fchown|truncate|ftruncate|fsync|fdatasync|opendir|fdopendir|readdir|closedir|rewinddir|mmap|munmap|msync|flock|fcntl|dup|dup2|pipe|mkstemp|mkdtemp|tmpfile|realpath|readlink|symlink|link|utime|utimes|futimes|sendfile|copy_file_range|ioctl|CreateFile\w*|ReadFile|WriteFile|CloseHandle|DeleteFile\w*|MoveFile\w*|CopyFile\w*|CreateDirectory\w*|RemoveDirectory\w*|FindFirstFile\w*|FindNextFile\w*|GetFileAttributes\w*|SetFilePointer\w*|FlushFileBuffers|std::ofstream|std::ifstream|std::fstream|ofstream|ifstream|fstream|std::filesystem::\w+|filesystem::\w+|fs::\w+)$/, only: ['c'] },
  { category: 'storage', test: /^(?:File|Dir|FileUtils|IO|Pathname|Tempfile)\.\w+$|^(?:Aws::S3::\w+|S3_BUCKET\.\w+|ActiveStorage::\w+|\w+\.attach|\w+\.purge|\w+\.purge_later)$/, only: ['rb'] },
  { category: 'storage', test: /^(?:Storage::\w+|File::\w+|file_put_contents|file_get_contents|fopen|fwrite|fread|fclose|unlink|mkdir|rmdir|rename|copy|move_uploaded_file|\$request->file|\$file->store\w*|\$file->move)(?:\(\)->\w+)*$/, only: ['php'] },
  { category: 'storage', test: /^(?:std::fs|fs|tokio::fs|File|OpenOptions|std::io::Write|BufWriter|BufReader)(?:::\w+)*$|^\w+\.(?:write_all|read_to_string|read_to_end|sync_all|flush)$/, only: ['rs'] },

  // ----------------------------------------------------------------- network --
  {
    category: 'network',
    test: /^(?:fetch|axios|ky|got|superagent|XMLHttpRequest|WebSocket|EventSource|undici|request|needle|phin|ofetch|\$fetch|useFetch|useAsyncData|wretch|redaxios)$|^(?:this\.)?(?:axios|api|client|http|https|httpClient|apiClient|instance|request|agent|graphql|apollo|apolloClient|urql|trpc|supabase|octokit|github|gh|openai|anthropic|ai|slack|twilio|sdk|\w+Client|\w+Api|\w+API|\w+Sdk|\w+SDK|\$http|\$axios|\$api|api\.\w+|routes\.\w+|server\.\w+)\.(?:\w+\.)*(?:get|post|put|patch|delete|head|options|request|query|mutate|mutation|rpc|invoke|call|send|fetch|create|list|retrieve|update|del|remove|upload|download|stream|connect|subscribe|emit|generate|complete|chat\.completions\.create|messages\.create|embeddings\.create|images\.generate|run|search|execute|useQuery|useMutation|useInfiniteQuery|prefetchQuery|fetchQuery|ensureQueryData)$|^URLSession(?:\.|$)|^(?:Alamofire|AF)\.|\.(?:dataTask|uploadTask|downloadTask)$|^(?:io|socket|ws|wss|pusher|ably|centrifuge|mqtt|mqttClient|nc|nats|grpc|grpcClient|stub)\.(?:emit|send|publish|connect|request|call|to|in|of|subscribe|unsubscribe|invoke)$|^(?:io|WebSocket|EventSource|XMLHttpRequest|Pusher|Ably|Centrifuge)$/,
    only: ['js'],
  },
  { category: 'network', test: /^(?:requests|httpx|aiohttp|urllib\.request|urllib3|http\.client|httplib2|treq|niquests|pycurl|websockets|websocket|socketio|sio|grpc|stub|channel|zmq|paho|mqtt|client|http_client|api_client|api|session_client|async_client|_client|self\.client|self\.http|self\.session_client|slack_client|openai|anthropic|boto3\.client|lambda_client|sqs_client|sns_client|ses_client|ec2|s3)\.(?:\w+\.)*(?:get|post|put|patch|delete|head|options|request|send|fetch|urlopen|open|ClientSession|AsyncClient|Client|Session|stream|connect|emit|invoke|call|create|chat\.completions\.create|messages\.create|completions\.create|embeddings\.create|generate|retrieve|list|update|search|query)$|^(?:urlopen|Request|websockets\.connect|aiohttp\.ClientSession|httpx\.AsyncClient|httpx\.Client|requests\.Session|socket\.socket|socket\.create_connection|grpc\.insecure_channel|grpc\.secure_channel|grpc\.aio\.insecure_channel)$/, only: ['py'] },
  { category: 'network', test: /^(?:this\.)?(?:restTemplate|webClient|httpClient|client|okHttpClient|retrofit|feignClient|\w*[cC]lient|\w*Feign|\w*Api|\w*Stub|\w*BlockingStub|\w*AsyncStub|graphQlClient|restClient|RestClient|WebClient|HttpClient|HttpRequest|Unirest|Jsoup|template)\.(?:\w+\.)*(?:getForObject|getForEntity|postForObject|postForEntity|postForLocation|exchange|execute|put|delete|patchForObject|get|post|patch|head|options|send|sendAsync|newCall|retrieve|bodyToMono|bodyToFlux|create|builder|newBuilder|newHttpClient|connect|call|invoke|newRequest|uri|method|request|body|block|subscribe|fetch|execute\w*|list\w*|get\w+|create\w+|update\w+|delete\w+)$|^(?:Socket|ServerSocket|URL|HttpURLConnection|HttpsURLConnection|DatagramSocket|WebSocketClient|StompSession|ManagedChannelBuilder)$/, only: ['jvm'] },
  { category: 'network', test: /^(?:this\.)?_?(?:httpClient|client|http|httpClientFactory|\w*[cC]lient|\w*Api|graphQLClient|restClient|flurl|\w+\.WithOAuthBearerToken)\.(?:\w+\.)*(?:GetAsync|PostAsync|PutAsync|PatchAsync|DeleteAsync|SendAsync|GetStringAsync|GetStreamAsync|GetByteArrayAsync|GetFromJsonAsync|PostAsJsonAsync|PutAsJsonAsync|PatchAsJsonAsync|DeleteFromJsonAsync|Send|CreateClient|GetJsonAsync|PostJsonAsync|ReceiveJson|ReceiveString|InvokeAsync|SendCoreAsync|StartAsync|ConnectAsync|Get\w+Async|Post\w+Async|Put\w+Async|Delete\w+Async|List\w+Async|Create\w+Async|Update\w+Async|Invoke\w+Async|Execute\w*Async)$|^(?:HttpClient|HttpRequestMessage|WebClient|HttpWebRequest|TcpClient|UdpClient|Socket|ClientWebSocket|HubConnection|HubConnectionBuilder|GrpcChannel|RestClient|RestRequest|FlurlClient)$/, only: ['cs'] },
  { category: 'network', test: /^(?:http|client|httpClient|c|hc|resty|req|grpc|net|websocket|ws|conn|nc|nats|mqtt|redis|rdb|\w+Client|\w+client|svc|api|sdk)\.(?:\w+\.)*(?:Get|Post|PostForm|Put|Patch|Delete|Head|Do|NewRequest|NewRequestWithContext|R|Dial|DialContext|DialTLS|Listen|ListenAndServe|Invoke|NewStream|Connect|Send|Recv|Request|Call|Write\w*|Read\w*|Publish|Subscribe|SendMessage|Ping|Execute|Fetch|Query|Mutate|Invoke\w*|Get\w+|Post\w+|Put\w+|Delete\w+|List\w+|Create\w+|Update\w+|Describe\w+)$|^(?:http|net|grpc|websocket|resty|fasthttp|gorequest|req)\.(?:Get|Post|PostForm|Head|Dial|DialContext|Listen|ListenAndServe|ListenAndServeTLS|NewClient|NewRequest|Serve|DefaultDialer\.Dial|Upgrade)$/, only: ['go'] },
  { category: 'network', test: /^(?:socket|connect|bind|listen|accept|accept4|send|sendto|sendmsg|recv|recvfrom|recvmsg|getaddrinfo|gethostbyname|getnameinfo|inet_pton|inet_ntop|setsockopt|getsockopt|shutdown|select|poll|epoll_create\w*|epoll_ctl|epoll_wait|kqueue|kevent|curl_easy_init|curl_easy_setopt|curl_easy_perform|curl_easy_cleanup|curl_multi_\w+|SSL_new|SSL_connect|SSL_accept|SSL_read|SSL_write|SSL_shutdown|SSL_free|BIO_\w+|WSAStartup|WSASocket\w*|WSASend|WSARecv|WSACleanup|closesocket|ioctlsocket|http_\w+|uv_tcp_\w+|uv_udp_\w+|uv_connect|uv_listen|uv_read_start|uv_write|evhttp_\w+|bufferevent_\w+|nng_\w+|zmq_\w+|MHD_\w+|mg_\w+|lws_\w+|ares_\w+|anetTcpConnect|anetTcpServer|anetAccept|anetRead|anetWrite|connSocket\w*|connConnect|connWrite|connRead|connAccept|connListen|aeCreateFileEvent|aeDeleteFileEvent)$/, only: ['c'] },
  { category: 'network', test: /^(?:Net::HTTP(?:\.\w+)*|HTTParty\.\w+|Faraday(?:\.\w+)*|RestClient\.\w+|HTTP\.\w+|Excon\.\w+|Typhoeus\.\w+|OpenURI\.open_uri|URI\.open|open-uri|Socket\.\w+|TCPSocket\.\w+|WebSocket::\w+|ActionCable\.server\.broadcast|\w+Channel\.broadcast_to|\w+Channel\.broadcast|\w+\.broadcast)$|^\w+\.(?:get|post|put|patch|delete|head|request)$/, only: ['rb'] },
  { category: 'network', test: /^(?:Http::\w+|Http::\w+::\w+|curl_init|curl_exec|curl_setopt\w*|curl_close|file_get_contents|fsockopen|stream_socket_client|socket_create|socket_connect|socket_send|socket_recv|\$client->(?:request|get|post|put|patch|delete|send|sendAsync|requestAsync)|\$guzzle->\w+|\$http->\w+)(?:\(\)->\w+)*$/, only: ['php'] },
  { category: 'network', test: /^(?:reqwest|hyper|ureq|isahc|surf|tonic|tungstenite|tokio_tungstenite|websocket|TcpStream|TcpListener|UdpSocket|Client|ClientBuilder|Request|awc)(?:::\w+)*$|^\w+\.(?:get|post|put|patch|delete|head|send|execute|connect|bind|send_to|recv_from|write_all|read_to_end)$/, only: ['rs'] },
  { category: 'network', test: /^URLSession(?:\.|$)|^(?:Alamofire|AF)\.|\.(?:dataTask|uploadTask|downloadTask|webSocketTask|data|upload|download|responseDecodable|responseJSON|responseData)$|^(?:NWConnection|NWListener|NWBrowser|URLSessionWebSocketTask|WebSocket|Starscream|SocketManager|SocketIOClient|Socket)\b|^(?:this\.|self\.)?(?:client|api|apiClient|http|httpClient|networkService|network|session)\.(?:get|post|put|patch|delete|request|send|fetch|perform|execute|call|data|upload|download)$/, only: ['swift'] },

  // ------------------------------------------------------------------ device --
  { category: 'device', test: /^(?:Linking|Share|Clipboard|Notifications|Camera|ImagePicker|MediaLibrary|Haptics|Alert|Vibration|Location|Geolocation|Permissions|UIApplication|AVCaptureSession|AVAudioSession|CLLocationManager|UNUserNotificationCenter|Battery|Brightness|Sensors|Accelerometer|Gyroscope|Magnetometer|Pedometer|Contacts|Calendar|LocalAuthentication|BiometricAuth|DocumentPicker|Print|ScreenOrientation|StatusBar|BackHandler|Appearance|Dimensions|PixelRatio|Keyboard|PushNotification|PushNotificationIOS|messaging|Bluetooth|BleManager|NfcManager|navigator\.\w+|window\.(?:open|print|alert|confirm|prompt)|Notification|speechSynthesis|WebAuthn|Intent|intent|context\.startActivity|startActivity|startService|sendBroadcast|registerReceiver|NotificationManager|notificationManager|NotificationCompat|LocationManager|locationManager|fusedLocationClient|SensorManager|sensorManager|CameraX|cameraProvider|MediaPlayer|mediaPlayer|AudioManager|audioManager|Vibrator|vibrator|ClipboardManager|clipboardManager|UIDevice|UIPasteboard|UIImpactFeedbackGenerator|UINotificationFeedbackGenerator|AVAudioPlayer|AVPlayer|CMMotionManager|PHPhotoLibrary|UIImagePickerController|LAContext|WKWebView|Process\.Start|Environment\.Exit|Clipboard\.\w+|Console\.\w+)\b/ },

  // --------------------------------------------------------------- telemetry --
  { category: 'telemetry', test: /^(?:DdRum|DdLogs|DdTrace|DdSdkReactNative|CustomerIO|Sentry|Bugsnag|analytics|Analytics|crashlytics|Crashlytics|mixpanel|Mixpanel|amplitude|Amplitude|posthog|PostHog|LDClient|ldClient|Datadog|datadog|datadogRum|datadogLogs|newrelic|NewRelic|honeycomb|Honeycomb|segment|Segment|statsd|StatsD|metrics|Metrics|meter|Meter|meterRegistry|MeterRegistry|counter|histogram|tracer|Tracer|otel|opentelemetry|trace\.getTracer|span|Span|appInsights|TelemetryClient|_telemetryClient|telemetryClient|telemetry|_telemetry|Telemetry|Application\.Insights|logtail|Logtail|rollbar|Rollbar|raven|Raven|prometheus|Prometheus|promClient|prom|registry|Registry|sentry_sdk|capture_exception|capture_message|statsd_client|dogstatsd|MetricRegistry|Micrometer|Timer|Counter|Gauge|Histogram|Summary)\b(?:\.(?:\w+\.)*\w+)?$/ },

  // ----------------------------------------------------------------- process --
  { category: 'process', test: /^(?:child_process|spawn|spawnSync|exec|execSync|execFile|execFileSync|fork|process\.exit|process\.kill|process\.abort|Deno\.(?:run|exit|Command|kill)|Bun\.(?:spawn|spawnSync|\$)|\$`|execa|execaSync|\$|zx|Worker|worker_threads|cluster\.fork|os\.setPriority|pm2\.\w+)$/, only: ['js'] },
  { category: 'process', test: /^(?:subprocess\.(?:run|call|check_call|check_output|Popen|getoutput|getstatusoutput)|os\.(?:system|popen|execv|execve|execvp|execl|execlp|spawn\w*|fork|forkpty|kill|killpg|_exit|abort|nice|setsid|setuid|setgid|waitpid|wait)|sys\.exit|exit|quit|multiprocessing\.(?:Process|Pool)|Process|Pool|signal\.signal|signal\.alarm|pty\.spawn|asyncio\.create_subprocess_\w+|sh\.\w+|plumbum\.\w+|pexpect\.\w+|importlib\.import_module|__import__|ctypes\.\w+|cffi\.\w+)$/, only: ['py'] },
  { category: 'process', test: /^(?:Runtime\.getRuntime\(\)\.exec|Runtime\.getRuntime\(\)\.halt|Runtime\.getRuntime|runtime\.exec|ProcessBuilder|System\.exit|System\.loadLibrary|System\.load|Thread\.sleep|Thread|Executors\.\w+|executor\.\w+|ForkJoinPool\.\w+|CompletableFuture\.\w+|Runtime\.exit|Runtime\.halt|exitProcess|ProcessHandle\.\w+|Signal\.\w+|thread|Timer|ScheduledExecutorService)(?:\.\w+)*$/, only: ['jvm'] },
  { category: 'process', test: /^(?:Process\.(?:Start|Kill|GetProcesses\w*|GetCurrentProcess)|Environment\.(?:Exit|FailFast)|AppDomain\.\w+|Thread\.(?:Sleep|Start)|Task\.(?:Run|Factory\.StartNew|Delay)|ThreadPool\.\w+|Assembly\.(?:Load\w*)|Activator\.CreateInstance\w*|Marshal\.\w+|NativeLibrary\.\w+|ProcessStartInfo)$/, only: ['cs'] },
  { category: 'process', test: /^(?:exec\.(?:Command|CommandContext|LookPath)|os\.(?:Exit|StartProcess|FindProcess|Getpid|Getenv|Setenv|Executable)|syscall\.\w+|signal\.(?:Notify|NotifyContext|Stop|Ignore|Reset)|log\.(?:Fatal\w*|Panic\w*)|runtime\.(?:GC|Goexit|GOMAXPROCS)|plugin\.Open|debug\.SetGCPercent|cmd\.(?:Run|Start|Output|CombinedOutput|Wait|Kill|StdoutPipe|StdinPipe|StderrPipe))$/, only: ['go'] },
  { category: 'process', test: /^(?:fork|vfork|clone|execv|execve|execvp|execvpe|execl|execle|execlp|posix_spawn\w*|system|popen|pclose|waitpid|wait|wait3|wait4|waitid|kill|killpg|raise|signal|sigaction|sigprocmask|sigsuspend|sigwait|alarm|setitimer|pause|exit|_exit|_Exit|abort|atexit|quick_exit|setsid|setpgid|setpgrp|getpid|getppid|daemon|nice|setpriority|setrlimit|getrlimit|chroot|setuid|setgid|seteuid|setegid|setgroups|pthread_create|pthread_join|pthread_cancel|pthread_kill|pthread_detach|pthread_exit|thrd_create|thrd_join|dlopen|dlsym|dlclose|dlerror|LoadLibrary\w*|GetProcAddress|FreeLibrary|CreateProcess\w*|CreateThread|ExitProcess|ExitThread|TerminateProcess|TerminateThread|ShellExecute\w*|WinExec|WaitForSingleObject|WaitForMultipleObjects|sched_yield|sched_setaffinity|prctl|ptrace|uv_spawn|uv_process_kill|redisFork|bioCreateBackgroundJob|bioSubmitJob)$/, only: ['c'] },
  { category: 'process', test: /^(?:system|spawn|exec|fork|Process\.\w+|Open3\.\w+|Kernel\.(?:system|spawn|exec|exit|exit!|abort|at_exit)|exit|exit!|abort|at_exit|Signal\.trap|trap|Thread\.new|Thread\.start|IO\.popen|PTY\.spawn|`)$/, only: ['rb'] },
  { category: 'process', test: /^(?:exec|shell_exec|system|passthru|proc_open|popen|pcntl_\w+|posix_\w+|exit|die|Process::\w+|Artisan::\w+|new Process|Process)$/, only: ['php'] },
  { category: 'process', test: /^(?:std::process|process|Command|std::thread|thread|tokio::spawn|tokio::process|spawn|rayon|libc)(?:::\w+)*$|^\w+\.(?:spawn|output|status|wait|kill)$/, only: ['rs'] },
];

/**
 * A plain instantiation of an exception the framework will turn into a
 * response. Only in a project with endpoints: in an app, `new
 * ValidationError` is an error, not a reply.
 */
const EXCEPTION_RESPONSE = /(?:^|[.:])(?:\w+Exception|\w*HttpError|ApiError|\w+ApiError|HttpProblem|ProblemDetails|Abort|ResponseStatusException|ErrorResponse|\w+ErrorResponse|HTTPError|HTTPException|APIException|Http\d{3}|\w*(?:NotFound|BadRequest|Unauthorized|Unauthenticated|Forbidden|Conflict|Validation|Unprocessable|TooManyRequests|Gone|NotAllowed|MethodNotAllowed|Unsupported|RequestTimeout|InternalServer|ServiceUnavailable|PaymentRequired|PreconditionFailed|NotAcceptable|NotImplemented|BadGateway|RateLimit)Error)$/;
const NOT_A_RESPONSE = /^(?:Error|TypeError|RangeError|SyntaxError|ReferenceError|EvalError|URIError|AggregateError|Exception|RuntimeException|IllegalArgumentException|IllegalStateException|NullPointerException|IndexOutOfBoundsException|UnsupportedOperationException|ArgumentException|ArgumentNullException|ArgumentOutOfRangeException|InvalidOperationException|NotImplementedException|NotSupportedException|ValueError|TypeError|KeyError|IndexError|RuntimeError|NotImplementedError|AssertionError|StopIteration|InterruptedException|IOException|FileNotFoundException|ClassNotFoundException|NoSuchElementException|NumberFormatException|CloneNotSupportedException|ExecutionException|TimeoutException|OperationCanceledException|TaskCanceledException|ObjectDisposedException|FormatException|OverflowException|DivideByZeroException|JsonException|SerializationException|ParseException|DateTimeParseException|MalformedURLException|URISyntaxException|SQLException|DataAccessException|DbUpdateException|ConcurrencyException|EntityNotFoundException|NoResultException|OptimisticLockException)$/;

/** Receiver types that say what a call into them is, when the graph declared one. */
const RECEIVER_TYPE_RULES: ReadonlyArray<{ category: EffectCategory; test: RegExp }> = [
  { category: 'database', test: /(?:Repository|Repo|Dao|DAO|Mapper|EntityManager|DataSource|DbContext|DbSet|SessionFactory|JdbcTemplate|NamedParameterJdbcTemplate|MongoTemplate|MongoOperations|R2dbcEntityTemplate|DatabaseClient|PrismaClient|PrismaService|Knex|Kysely|Drizzle|Sequelize|ConnectionPool|MongoCollection|Datastore|IDbConnection|IRepository|IReadRepository|IUnitOfWork|UnitOfWork|DSLContext|EntityManagerFactory|SessionFactory|AsyncSession)(?:<[^>]*>)?$/ },
  { category: 'network', test: /(?:HttpClient|RestTemplate|WebClient|RestClient|OkHttpClient|Retrofit|AxiosInstance|Axios|IHttpClientFactory|HttpClientFactory|GraphQLClient|GraphQlClient|WebSocketClient|StompSession|ManagedChannel|BlockingStub|AsyncStub|FeignClient|ApolloClient)(?:<[^>]*>)?$/ },
  { category: 'auth', test: /(?:JwtService|JwtDecoder|JwtEncoder|PasswordEncoder|AuthenticationManager|UserManager|SignInManager|RoleManager|JwtSecurityTokenHandler|IPasswordHasher|PasswordHasher|KeycloakClient|OAuth2AuthorizedClientService)(?:<[^>]*>)?$/ },
  { category: 'queue', test: /(?:Queue|IQueue|Producer|IProducer|Publisher|IPublisher|IPublishEndpoint|ISendEndpoint|IBus|IMessageBus|MessageBus|EventBus|IEventBus|Channel|KafkaTemplate|RabbitTemplate|JmsTemplate|StreamBridge|SqsClient|SnsClient|AmazonSQS|AmazonSNS|ApplicationEventPublisher|EventEmitter2|IBackgroundJobClient|BackgroundJobClient|Agenda|PgBoss)(?:<[^>]*>)?$/ },
  { category: 'email', test: /(?:MailerService|JavaMailSender|MailSender|IEmailSender|SendGridClient|SESClient|AmazonSimpleEmailService|Transporter|Resend|PostmarkClient)(?:<[^>]*>)?$/ },
  { category: 'payments', test: /(?:Stripe|StripeClient|BraintreeGateway|PayPalClient|Razorpay|Adyen|Mollie|Paddle|Chargebee)(?:<[^>]*>)?$/ },
  { category: 'cache', test: /(?:CacheManager|IMemoryCache|IDistributedCache|RedisTemplate|StringRedisTemplate|Redis|RedisClient|Jedis|Lettuce|RedissonClient|MemcachedClient|IConnectionMultiplexer|ConnectionMultiplexer|IDatabase)(?:<[^>]*>)?$/ },
  { category: 'storage', test: /(?:S3Client|AmazonS3|BlobClient|BlobServiceClient|BlobContainerClient|MinioClient|IFileProvider|Cloudinary|FileSystem|IFileSystem)(?:<[^>]*>)?$/ },
];

export interface EffectInput {
  /** The call as written (the whole member chain), or the reference name the index kept. */
  text: string;
  kind: 'calls' | 'instantiates';
  language?: Language | null;
  project?: ProjectKind;
  /** The declared type of the receiver, when the graph has it (`OwnerRepository`). */
  receiverType?: string | null;
  /** The argument list, abbreviated, when it was read — where the model of a `knex('users')` comes from. */
  args?: string | null;
}

export interface Effect {
  category: EffectCategory;
  /** The table / model / collection, when it can be read off the call: `user`, `Owner`, `TodoItems`. */
  model?: string;
  /** Read or write, from the method name. Only for `database`. */
  access?: 'read' | 'write';
}

function familiesOf(language: Language | null | undefined): Family[] {
  if (!language) return [];
  const out: Family[] = [];
  for (const [family, set] of Object.entries(FAMILIES) as Array<[Family, ReadonlySet<Language>]>) if (set.has(language)) out.push(family);
  return out;
}

/** Normalise the call text the rules see: `await`/`new` dropped, `?.` as `.`, `this.` kept. */
export function normaliseCall(text: string): string {
  return text
    .replace(/^\s*(?:await|new|yield|return|throw)\s+/, '')
    .replace(/^\s*(?:await|new)\s+/, '')
    .replace(/\?\./g, '.')
    .replace(/!\./g, '.')
    .replace(/\s+/g, '')
    .replace(/<[^<>]*>/g, '');
}

/**
 * What a call is, when it is one of the things the table names. `null` for
 * everything else — a plain call into a library is not an effect.
 */
export function classifyEffect(input: EffectInput): Effect | null {
  // Rules see the chain without its argument lists: `res.status(404).json`
  // is `res.status.json`, `ResponseEntity.status(HttpStatus.NOT_FOUND).body`
  // is `ResponseEntity.status.body`.
  const text = normaliseCall(input.text).replace(/\([^()]*\)/g, '');
  if (text === '') return null;
  const families = familiesOf(input.language);
  const project = input.project ?? 'app';

  for (const rule of EFFECT_RULES) {
    if (rule.only && !rule.only.some((f) => families.includes(f))) {
      // An ungated language (no family) still gets the JS rows — the table
      // grew up on them and the old tests call with no language.
      if (input.language) continue;
      if (!rule.only.includes('js')) continue;
    }
    if (rule.instantiates && input.kind !== 'instantiates') continue;
    if (rule.test.test(text)) return withShape(rule.category, text, input.args ?? null, input.language ?? null, null);
  }

  // The receiver's declared type — a library's, never a class of the project
  // (the caller checks): `OwnerRepository owners` makes `owners.save` the
  // database when no row above knew the name.
  if (input.receiverType) {
    const type = input.receiverType.replace(/^(?:readonly|private|public|protected|final|static)\s+/g, '').trim();
    for (const rule of RECEIVER_TYPE_RULES) {
      if (rule.test.test(type)) return withShape(rule.category, text, input.args ?? null, input.language ?? null, type);
    }
  }

  // A thrown web exception is a response, in a project that has endpoints.
  if (project !== 'app' && (input.kind === 'instantiates' || families.includes('py') || families.includes('swift'))) {
    const last = text.split(/[.:]/).pop() ?? text;
    if (EXCEPTION_RESPONSE.test(text) && !NOT_A_RESPONSE.test(last)) return { category: 'response' };
  }
  return null;
}

const READ_OPS =
  /^(?:find\w*|findone|get|getone|getmany|getall\w*|getbyid\w*|getasync|list\w*|count\w*|aggregate|select\w*|query\w*|queryrow\w*|scalar\w*|first\w*|single\w*|last\w*|all|any\w*|exists\w*|tolist\w*|toarray\w*|filter|where|fetch\w*|load\w*|read\w*|scan|search|paginate|pluck|distinct|group\w*|order\w*|include\w*|join\w*|objects|values|values_list|iterator|stream|max|min|sum|avg|average|exists\?|one|one_or_none|scalars?|find_by|find_each|firstordefault\w*|singleordefault\w*|countdocuments|rows|row|preload|take|limit|offset|skip|raw|fromsql\w*|\$queryraw|get_or_404|get_object_or_404|describe\w*|head\w*|retrieve|show|index|lookup|peek|contains|has|check|isempty|is_empty|size|length|fetchone|fetchall|fetchmany|refresh)$/i;
const WRITE_OPS =
  /^(?:create\w*|update\w*|upsert\w*|delete\w*|destroy\w*|save\w*|insert\w*|remove\w*|add\w*|persist\w*|merge|flush|commit|bulk\w*|batch\w*|put\w*|set\w*|exec|execute\w*|savechanges\w*|increment\w*|decrement\w*|truncate|drop|sqlmodel_update|find_or_create\w*|update_or_create|firstorcreate|updateorcreate|get_or_create|delete_all|update_all|insert_all|upsert_all|refresh_from_db|patch|write\w*|push|pull|inc|attach|detach|sync|replace\w*|touch|purge|restore|forcedelete|store|migrate|automigrate|createmany|updatemany|deletemany|\$executeraw|\$transaction|transaction|begin|rollback|expunge|lock|unlock|import|reindex|rebuild|clear|reset|empty|fill|assign|append|prepend|move|copy|rename|link|unlink|register|unregister|enable|disable|activate|deactivate|approve|reject|publish|unpublish|archive|unarchive|complete|cancel|confirm|revoke|grant|deny|ban|unban|verify|invalidate|expire|evict|generate|seed)$/i;

/** The category plus what the text says about the model and the access. */
function withShape(category: EffectCategory, text: string, args: string | null, language: Language | null, receiverType: string | null): Effect {
  if (category !== 'database') return { category };
  const out: Effect = { category };
  const segments = text.replace(/\([^()]*\)/g, '').split(/[.:]+/).filter(Boolean);
  const last = segments[segments.length - 1] ?? '';
  const model = modelOf(segments, args, receiverType);
  if (model) out.model = model;
  const op = last.replace(/[!?]$/, '');
  if (op === 'exec' && language === 'python') out.access = 'read';
  else if (WRITE_OPS.test(op)) out.access = 'write';
  else if (READ_OPS.test(op)) out.access = 'read';
  return out;
}

const MODEL_SUFFIX = /(?:Repository|Repo|Dao|DAO|Model|Mapper|Store|Collection|Table|Service|Entity|Manager)$/;

function modelOf(segments: string[], args: string | null, receiverType: string | null): string | null {
  const noThis = segments[0] === 'this' || segments[0] === 'self' ? segments.slice(1) : segments;
  const first = noThis[0] ?? '';
  const secondLast = noThis.length >= 3 ? noThis[noThis.length - 2]! : '';
  // `prisma.user.create`, `db.users.insert`, `_context.TodoItems.Add`, `this.prisma.user.findMany`.
  if (noThis.length >= 3 && /^[A-Za-z_$][\w$]*$/.test(secondLast) && !/^(?:objects|query|session|db|\$|from|table|collection|opsForValue|Items)$/.test(secondLast) && !MODEL_SUFFIX.test(secondLast) && secondLast !== '$transaction') {
    if (/^(?:prisma|db|database|orm|em|drizzle|sql|_context|context|dbContext|_db|ctx|this)$/i.test(first) || /(?:Context|Client|Prisma|Db|DB)$/.test(first)) return secondLast;
  }
  // `usersRepository.save`, `_orderRepository.AddAsync`, `userModel.find`, `ownerDao.get`.
  const receiver = noThis.length >= 2 ? noThis[0]! : '';
  if (receiver && MODEL_SUFFIX.test(receiver) && !/^(?:this|self)$/.test(receiver)) {
    const stem = receiver.replace(/^_+/, '').replace(MODEL_SUFFIX, '');
    if (stem) return stem;
  }
  // `User.objects.filter`, `User.query.get`, `User.find`, `Todo.query(on:)`, `User::find`.
  if (noThis.length >= 2 && /^[A-Z][A-Za-z0-9]*$/.test(first) && !/^(?:DB|ActiveRecord|Files|File|Path|Base)$/.test(first)) return first;
  // Spring: `owners.save` where `owners` is an `OwnerRepository`.
  if (receiverType) {
    const stem = receiverType.replace(/<[^>]*>/g, '').replace(/^I(?=[A-Z])/, '').replace(MODEL_SUFFIX, '');
    if (stem && stem !== receiverType && /^[A-Z]/.test(stem) && !/^(?:Entity|Db|Data|Jdbc|Mongo|Session|Async)$/.test(stem)) return stem;
  }
  // `knex('users')`, `db.from('users')`, `collection('todos')`, `sql.table('x')`.
  if (args && /^(?:knex|db|collection|table|from|into|selectFrom|insertInto|updateTable|deleteFrom|sql\.table|query|getRepository|getCollection|model)$/i.test(noThis[noThis.length - 1] ?? '')) {
    const m = /^['"`]([\w.-]+)['"`]/.exec(args);
    if (m) return m[1]!;
  }
  return null;
}

// =============================================================================
// Response status
// =============================================================================

const STATUS_BY_NAME: Record<string, number> = {
  ok: 200, success: 200, created: 201, accepted: 202, nocontent: 204, resetcontent: 205, partialcontent: 206,
  movedpermanently: 301, found: 302, redirect: 302, seeother: 303, notmodified: 304, temporaryredirect: 307, permanentredirect: 308,
  badrequest: 400, unauthorized: 401, unauthenticated: 401, paymentrequired: 402, forbidden: 403, notfound: 404, methodnotallowed: 405,
  notacceptable: 406, proxyauthenticationrequired: 407, requesttimeout: 408, conflict: 409, gone: 410, lengthrequired: 411,
  preconditionfailed: 412, payloadtoolarge: 413, requestentitytoolarge: 413, uritoolong: 414, unsupportedmediatype: 415,
  rangenotsatisfiable: 416, expectationfailed: 417, imateapot: 418, misdirectedrequest: 421, unprocessableentity: 422, unprocessable: 422,
  locked: 423, faileddependency: 424, tooearly: 425, upgraderequired: 426, preconditionrequired: 428, toomanyrequests: 429, throttled: 429,
  requestheaderfieldstoolarge: 431, unavailableforlegalreasons: 451, internalservererror: 500, internalerror: 500, servererror: 500, internalserver: 500,
  notimplemented: 501, badgateway: 502, serviceunavailable: 503, gatewaytimeout: 504, httpversionnotsupported: 505, insufficientstorage: 507,
  loopdetected: 508, networkauthenticationrequired: 511, validationproblem: 400, problem: 500, forbid: 403, challenge: 401, entitynotfound: 404,
};

function statusOfName(raw: string): number | null {
  let name = raw.replace(/^(?:HttpStatus|HTTPStatus|StatusCodes|StatusCode|http|status|HttpStatusCode|Status|HTTP_|HTTP)[._]?/, '');
  name = name.replace(/(?:Exception|Error|Response|Result|Async|Http|Status|Code)$/g, '').replace(/^Http(?=[A-Z])/, '');
  const key = name.replace(/[^A-Za-z0-9]/g, '').toLowerCase();
  if (key === '') return null;
  if (/^\d{3}$/.test(key)) return Number(key);
  const m = /^(?:http)?(\d{3})$/.exec(key) ?? /(?:^|[a-z_])([1-5]\d{2})(?:[a-z_]|$)/.exec(key);
  if (m) return Number(m[1]);
  if (STATUS_BY_NAME[key] !== undefined) return STATUS_BY_NAME[key]!;
  // `UserNotFound`, `InvalidTokenUnauthorized`: the status name ends the class name.
  for (const [known, code] of Object.entries(STATUS_BY_NAME)) {
    if (known.length >= 6 && key.endsWith(known)) return code;
  }
  return null;
}

/**
 * The status code a response site sends, when it is literal: the number in
 * `res.status(404)`, the name in `ResponseEntity.notFound()`,
 * `throw new NotFoundException()`, `c.JSON(http.StatusCreated, …)`,
 * `HTTPException(status_code=404)`, `Abort(.notFound)`. Null when the code
 * is a variable or the site sets none.
 */
export function responseStatus(text: string, args: string | null | undefined, _kind: 'calls' | 'instantiates' = 'calls'): number | null {
  const call = normaliseCall(text);
  // `res.status(404).json`, `reply.code(201).send`, `ResponseEntity.status(HttpStatus.NOT_FOUND).body`.
  const inChain = /(?:^|\.)(?:status|sendStatus|code|Status|StatusCode|SendStatus|withStatus|with_status)\(([^()]+)\)/.exec(call);
  if (inChain) {
    const s = literalStatus(inChain[1]!);
    if (s !== null) return s;
  }
  const last = (call.replace(/\([^()]*\)/g, '').split(/[.:]/).pop() ?? call).replace(/^new/, '');
  const a = args ?? '';
  // The status is the argument: `res.status(404)`, `res.sendStatus(204)`, `abort(404)`, `StatusCode(500)`, `c.String(200, …)`, `http.Error(w, m, 500)`.
  if (/^(?:status|sendStatus|code|abort|StatusCode|Status|SendStatus|WriteHeader|String|Data|JSON|IndentedJSON|XML|YAML|HTML|AbortWithStatus|AbortWithStatusJSON|Error|Redirect|head|Problem|error)$/.test(last)) {
    const fromArgs = literalStatus(firstStatusToken(a, last === 'Error' || last === 'Redirect' ? 'last' : 'first'));
    if (fromArgs !== null) return fromArgs;
    if (last === 'Redirect') return 302;
    if (last === 'Problem' || last === 'error') return 500;
  }
  // `status_code=404`, `status=400`, `statusCode: 404`, `HttpStatus.CREATED` anywhere in the arguments.
  const kw = /(?:status_code|statusCode|status|code)\s*[=:]\s*([\w.]+)/.exec(a);
  if (kw) {
    const s = literalStatus(kw[1]!);
    if (s !== null) return s;
  }
  const named = /\b(?:HttpStatus|HTTPStatus|StatusCodes|HttpStatusCode|http)\.(\w+)/.exec(a) ?? /(?:^|[\s,(])\.(\w+)/.exec(a);
  if (named) {
    const s = statusOfName(named[1]!);
    if (s !== null) return s;
  }
  // `new HttpException(message, 403)`, `new HttpException(422, { errors })`,
  // `abort(404, …)`: an exception or a reply takes its status wherever the
  // argument list carries one literal.
  if (/Exception$|Error$|^Abort$|^abort$|^HTTPError$/.test(last)) {
    for (const part of splitArgs(a)) {
      const s = literalStatus(part);
      if (s !== null) return s;
    }
  }
  // The name says it: `NotFoundException`, `ResponseEntity.notFound().build`, `TypedResults.NoContent`, `Ok`, `Http404`.
  const segments = call.replace(/\([^()]*\)/g, '').split(/[.:]/).filter(Boolean);
  for (let i = segments.length - 1; i >= 0; i--) {
    const seg = segments[i]!;
    if (/^(?:json|send|end|render|view|View|Json|Content|File|jsonify|JSONResponse|Response|HttpResponse|JsonResponse|render_template|body|text|html|build|status|type|header|headers|set|res|response|reply|rep|ctx|c|context|this|self|http|w|rw|ResponseEntity|Results|TypedResults|HttpStatus|NextResponse)$/.test(seg)) continue;
    const s = statusOfName(seg);
    if (s !== null) return s;
    break;
  }
  if (/^(?:redirect|redirect_to|RedirectResponse|HttpResponseRedirect|RedirectToAction|RedirectToPage|RedirectToRoute|LocalRedirect|permanentRedirect|Redirect)$/.test(last)) return /permanent/i.test(last) ? 308 : 302;
  if (/^(?:Created|CreatedAtAction|CreatedAtRoute|created)$/.test(last)) return 201;
  return null;
}

/**
 * The status a reply sends when it sets none — 200 — for the calls that send a
 * body and default to it: Express / Koa / Fastify / Hono `res.json`,
 * `res.send`, `res.render`, `reply.send`, `c.json`; `NextResponse.json`;
 * Python's `JSONResponse`, `jsonify`, `render_template`, `HttpResponse`;
 * Rails' `render`; Laravel's `response()->json`. Null when the chain sets a
 * status of its own (`res.status(code).json` — a variable code is unknown,
 * not 200), when the call ends a response without a body (`end`,
 * `sendStatus`), or when the call is not one of these.
 */
export function implicitResponseStatus(text: string): number | null {
  const call = normaliseCall(text);
  if (/(?:^|\.)(?:status|sendStatus|code|Status|StatusCode|SendStatus|withStatus|with_status|writeHead)\(/.test(call)) return null;
  const bare = call.replace(/\([^()]*\)/g, '');
  if (/^(?:res|response|reply|rep|ctx|c|context)(?:\.(?:type|set|header|headers|append|cookie|clearCookie|vary|location|links|format))*\.(?:json|jsonp|send|render|sendFile|download|text|html|body|stream|file|view)$/.test(bare)) return 200;
  if (/^(?:NextResponse|Response)\.json$/.test(bare)) return 200;
  if (/^(?:JSONResponse|HTMLResponse|PlainTextResponse|ORJSONResponse|UJSONResponse|jsonify|render_template|render|make_response|HttpResponse|JsonResponse|send_file|send_from_directory)$/.test(bare)) return 200;
  if (/^(?:render|render_to_string|respond_with)$/.test(bare)) return 200;
  if (/^response\(\)->(?:json|view)$|^response->json$|^view$/.test(call.replace(/\s+/g, ''))) return 200;
  return null;
}

/** The abbreviated argument list split on its top-level commas. */
function splitArgs(args: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of args) {
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) {
      out.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

function firstStatusToken(args: string, which: 'first' | 'last'): string {
  const parts = splitArgs(args);
  if (parts.length === 0) return '';
  return which === 'first' ? parts[0]! : parts[parts.length - 1]!;
}

function literalStatus(token: string): number | null {
  const t = token.trim();
  if (/^\d{3}$/.test(t)) return Number(t);
  const named = /^(?:HttpStatus|HTTPStatus|StatusCodes|HttpStatusCode|http|status|Status|HttpStatusCodes|StatusCode|HTTPResponseStatus)\.(\w+)$/.exec(t) ?? /^\.(\w+)$/.exec(t) ?? /^(?:HTTP_|StatusCodes\.)(\w+)$/.exec(t);
  if (named) return statusOfName(named[1]!);
  if (/^[A-Z][A-Z_]+$/.test(t)) return statusOfName(t);
  return null;
}

/** The word the legend and a box's sub line use for a category. */
export function categoryWord(category: string): string {
  switch (category) {
    case 'database':
      return 'database';
    case 'response':
      return 'response';
    case 'queue':
      return 'queue';
    case 'email':
      return 'email';
    case 'payments':
      return 'payments';
    case 'cache':
      return 'cache';
    case 'auth':
      return 'auth';
    case 'process':
      return 'process';
    default:
      return category;
  }
}
