#!/usr/bin/env bash
# Creates the QuickBite ECS services on the `quickbite` cluster.
set -euo pipefail
C=quickbite
NET='awsvpcConfiguration={subnets=[subnet-08e994180c30c17a9,subnet-00bb8e8e3ceb0a9db],securityGroups=[sg-0fac3ae243d3f103e],assignPublicIp=ENABLED}'
TGC=$(aws elbv2 describe-target-groups --names quickbite-core-tg --query 'TargetGroups[0].TargetGroupArn' --output text)
TGO=$(aws elbv2 describe-target-groups --names quickbite-order-tg --query 'TargetGroups[0].TargetGroupArn' --output text)
DEP='deploymentCircuitBreaker={enable=true,rollback=true},maximumPercent=200,minimumHealthyPercent=100'
COMMON=(--cluster $C --launch-type FARGATE --platform-version LATEST --network-configuration "$NET"
        --deployment-configuration "$DEP" --propagate-tags SERVICE --enable-ecs-managed-tags
        --tags key=project,value=quickbite key=env,value=benchmark)
sc_server(){ # $1 port name/dns  $2 port
  echo "{\"enabled\":true,\"namespace\":\"quickbite\",\"services\":[{\"portName\":\"$1\",\"discoveryName\":\"$1\",\"clientAliases\":[{\"port\":$2,\"dnsName\":\"$1\"}]}]}"; }
SC_CLIENT='{"enabled":true,"namespace":"quickbite"}'

svc(){ aws ecs create-service "${COMMON[@]}" "$@" --query 'service.[serviceName,status,taskDefinition]' --output text; }

svc --service-name core-service --task-definition core-service --desired-count 1 \
    --load-balancers targetGroupArn=$TGC,containerName=core-service,containerPort=3000 \
    --health-check-grace-period-seconds 60 --service-connect-configuration "$(sc_server core-service 3000)"
svc --service-name core-worker --task-definition core-worker --desired-count 1 \
    --service-connect-configuration "$SC_CLIENT"
svc --service-name order-service --task-definition order-service --desired-count 1 \
    --load-balancers targetGroupArn=$TGO,containerName=order-service,containerPort=3001 \
    --health-check-grace-period-seconds 60 --service-connect-configuration "$(sc_server order-service 3001)"
svc --service-name order-worker --task-definition order-worker --desired-count 1 \
    --service-connect-configuration "$SC_CLIENT"
echo "ALB: http://$(aws elbv2 describe-load-balancers --names quickbite-alb --query 'LoadBalancers[0].DNSName' --output text)"
