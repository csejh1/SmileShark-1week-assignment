FROM public.ecr.aws/docker/library/nginx:1.25-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["/bin/sh", "-c", "sleep 10 && exec nginx -g 'daemon off;'"]
