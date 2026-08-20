import http from 'node:http';
const port=Number(process.env.PORT??3000);let requests=0;
const server=http.createServer((request,response)=>{requests++;if(request.url==='/health'){response.end('ok\n');return}if(request.url==='/metrics'){response.end(`requests ${requests}\n`);return}response.statusCode=404;response.end('not found\n')});
server.listen(port,'127.0.0.1',()=>process.stdout.write(`ready ${port}\n`));
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>server.close(()=>process.exit(0)));
