# PetClinic AWS 배포 가이드 (콘솔 전용)

---

## 최종 아키텍처

```
사용자
  │ HTTPS
  ▼
CloudFront + WAF (cf-waf)
  ├── /*            → S3 (React 정적 파일)
  └── /petclinic/*  → ALB + WAF (alb-waf, 커스텀 헤더 검증)
                          │ [Public Subnet]
                          ▼
                     ECS WEB - nginx (Rolling)
                          │ [Private Subnet]
                          │ HTTP → Internal ALB (petclinic-was-internal-alb)
                          ▼
                     ECS WAS - Spring Boot (Rolling)
                          │ [Private Subnet]
                          ▼
                     RDS MySQL (petclinic-db)
                     [Private Subnet, KMS 암호화]

감사/관측:
  CloudTrail → S3 (petclinic-cloudtrail-*)  ← 모든 API 호출 기록
  CloudWatch → 로그(/ecs/*), 알람(CPU/5xx/RDS)
  Secrets Manager (aws/secretsmanager KMS) ← DB 자격증명
```

## CI/CD 파이프라인 구조

```
GitHub Push (master)
        │
        ▼
GitHub Actions (OIDC)
        ├── [Frontend] npm build → S3 sync → CF invalidation
        └── CodePipeline 트리거 (WAS, WEB)
                  │
       ┌──────────┴──────────┐
       ▼                     ▼
CodePipeline (WAS)    CodePipeline (WEB)
  ├── Source: GitHub    ├── Source: GitHub
  ├── Build: CodeBuild  ├── Build: CodeBuild
  └── Deploy: ECS       └── Deploy: ECS
       (Rolling)              (Rolling)
```

## 네트워크 구성

```
VPC 10.0.0.0/16
  ├── Public  Subnet 2a  10.0.1.0/24  → IGW + NAT-2a  (ALB, NAT)
  ├── Public  Subnet 2c  10.0.2.0/24  → IGW + NAT-2c  (ALB, NAT)
  ├── Private Subnet 2a  10.0.11.0/24 → NAT-2a         (ECS WEB, WAS)
  ├── Private Subnet 2c  10.0.12.0/24 → NAT-2c         (ECS WEB, WAS)
  ├── Data    Subnet 2a  10.0.21.0/24 → 없음            (RDS — 인터넷 경로 없음)
  └── Data    Subnet 2c  10.0.22.0/24 → 없음            (RDS — 인터넷 경로 없음)

라우팅 테이블 (4개):
  rt-public      → 0.0.0.0/0 IGW        (public-2a, public-2c)
  rt-private-2a  → 0.0.0.0/0 NAT-2a     (private-2a)
  rt-private-2c  → 0.0.0.0/0 NAT-2c     (private-2c)
  rt-data        → 로컬만               (data-2a, data-2c)
```

---

## 사전 준비

- AWS 계정 로그인 완료
- GitHub 리포지토리 생성 및 코드 push 완료
- 리전 고정: **아시아 태평양(서울) ap-northeast-2**

---

## 1단계. VPC 생성

### 1-1. VPC 생성

1. 검색창 → `VPC` → **VPC** 클릭
2. 왼쪽 메뉴 **VPC** → **VPC 생성** 클릭
3. 설정:
   - 생성할 리소스: `VPC만`
   - 이름 태그: `petclinic-vpc`
   - IPv4 CIDR: `10.0.0.0/16`
4. **VPC 생성**

### 1-2. 서브넷 4개 생성

왼쪽 메뉴 **서브넷** → **서브넷 생성**

아래 4개를 순서대로 생성 (각각 **서브넷 추가** 버튼으로 한 화면에서 가능):

| 이름 | AZ | CIDR | 용도 |
|------|-----|------|------|
| `petclinic-public-2a` | ap-northeast-2a | `10.0.1.0/24` | ALB |
| `petclinic-public-2c` | ap-northeast-2c | `10.0.2.0/24` | ALB |
| `petclinic-private-2a` | ap-northeast-2a | `10.0.11.0/24` | ECS (WEB, WAS) |
| `petclinic-private-2c` | ap-northeast-2c | `10.0.12.0/24` | ECS (WEB, WAS) |
| `petclinic-data-2a` | ap-northeast-2a | `10.0.21.0/24` | RDS |
| `petclinic-data-2c` | ap-northeast-2c | `10.0.22.0/24` | RDS |

> **가용 영역 선택 이유**: ap-northeast-2a, ap-northeast-2c를 사용합니다. 2b는 일부 인스턴스 타입이 제공되지 않을 수 있어 2a+2c 조합이 실무에서 더 안정적입니다.

> **Data 서브넷 격리 원칙**: Data 서브넷은 라우팅 테이블에 `0.0.0.0/0` 경로 자체가 없습니다. RDS가 인터넷으로 나가는 경로가 물리적으로 차단되며, 접근은 보안 그룹(`petclinic-rds-sg`)이 WAS에서만 허용합니다.

- VPC: `petclinic-vpc` 선택
- **서브넷 생성**

### 1-3. 인터넷 게이트웨이(IGW) 생성 및 연결

1. 왼쪽 메뉴 **인터넷 게이트웨이** → **인터넷 게이트웨이 생성**
2. 이름: `petclinic-igw` → **생성**
3. 생성된 IGW 선택 → **작업** → **VPC에 연결**
4. `petclinic-vpc` 선택 → **연결**

### 1-4. NAT 게이트웨이 생성 (AZ별 1개씩)

> AZ마다 NAT GW를 두면 한 AZ 장애 시 다른 AZ의 ECS가 영향받지 않습니다. (단일 NAT GW는 장애점이 됨)
> 비용: NAT GW 1개당 약 $32/월 → 2개 운영 시 추가 $32 발생. 실무 HA 구성의 기본 비용.

**NAT GW 2a:**

1. 왼쪽 메뉴 **NAT 게이트웨이** → **NAT 게이트웨이 생성**
2. 설정:
   - 이름: `petclinic-nat-2a`
   - 서브넷: `petclinic-public-2a`
   - 연결 유형: `퍼블릭`
   - **탄력적 IP 할당** 클릭 (자동 생성)
3. **NAT 게이트웨이 생성**

**NAT GW 2c:**

4. **NAT 게이트웨이 생성**
5. 설정:
   - 이름: `petclinic-nat-2c`
   - 서브넷: `petclinic-public-2c`
   - 연결 유형: `퍼블릭`
   - **탄력적 IP 할당** 클릭 (자동 생성)
6. **NAT 게이트웨이 생성**

> 두 NAT GW 모두 상태가 `Available`이 될 때까지 기다린 후 다음 진행 (2~3분)

### 1-5. 라우팅 테이블 생성

**Public 라우팅 테이블:**

1. 왼쪽 메뉴 **라우팅 테이블** → **라우팅 테이블 생성**
2. 이름: `petclinic-rt-public`, VPC: `petclinic-vpc` → **생성**
3. 생성된 테이블 클릭 → **라우팅** 탭 → **라우팅 편집**
4. **라우팅 추가**: 대상 `0.0.0.0/0`, 대상(Target) `인터넷 게이트웨이` → `petclinic-igw` → **저장**
5. **서브넷 연결** 탭 → **서브넷 연결 편집**
6. `petclinic-public-2a`, `petclinic-public-2c` 체크 → **저장**

**Private 라우팅 테이블 — 2a (NAT-2a 경유):**

> AZ별로 각자 NAT GW를 바라보게 해야 AZ 장애 시 다른 AZ가 영향받지 않습니다.

1. **라우팅 테이블 생성**
2. 이름: `petclinic-rt-private-2a`, VPC: `petclinic-vpc` → **생성**
3. **라우팅** 탭 → **라우팅 편집**
4. **라우팅 추가**: 대상 `0.0.0.0/0`, Target `NAT 게이트웨이` → `petclinic-nat-2a` → **저장**
5. **서브넷 연결** 탭 → **서브넷 연결 편집**
6. `petclinic-private-2a` 만 체크 → **저장**

**Private 라우팅 테이블 — 2c (NAT-2c 경유):**

7. **라우팅 테이블 생성**
8. 이름: `petclinic-rt-private-2c`, VPC: `petclinic-vpc` → **생성**
9. **라우팅** 탭 → **라우팅 편집**
10. **라우팅 추가**: 대상 `0.0.0.0/0`, Target `NAT 게이트웨이` → `petclinic-nat-2c` → **저장**
11. **서브넷 연결** 탭 → **서브넷 연결 편집**
12. `petclinic-private-2c` 만 체크 → **저장**

**Data 라우팅 테이블 (인터넷 경로 없음 — 2a/2c 공용):**

> RDS는 외부와 통신할 필요가 없으므로 AZ 구분 없이 단일 테이블 사용.
> `0.0.0.0/0` 경로를 추가하지 않습니다 — VPC 로컬 경로만 자동 존재.

13. **라우팅 테이블 생성**
14. 이름: `petclinic-rt-data`, VPC: `petclinic-vpc` → **생성**
15. 라우팅 편집 없이 바로 **서브넷 연결** 탭 → **서브넷 연결 편집**
16. `petclinic-data-2a`, `petclinic-data-2c` 체크 → **저장**

**✅ 1단계 완료 확인**
- VPC → `petclinic-vpc` 상태 `Available`
- 서브넷 **6개** 목록 확인: public-2a, public-2c, private-2a, private-2c, data-2a, data-2c
- 인터넷 게이트웨이 `petclinic-igw` → 상태 `Attached`
- NAT 게이트웨이 **2개** 모두 상태 `Available`: `petclinic-nat-2a`(public-2a), `petclinic-nat-2c`(public-2c)
- 라우팅 테이블 **4개** 확인:
  - `petclinic-rt-public` → 0.0.0.0/0 IGW, 서브넷 2개(public-2a/2c)
  - `petclinic-rt-private-2a` → 0.0.0.0/0 `petclinic-nat-2a`, 서브넷 1개(private-2a)
  - `petclinic-rt-private-2c` → 0.0.0.0/0 `petclinic-nat-2c`, 서브넷 1개(private-2c)
  - `petclinic-rt-data` → 0.0.0.0/0 없음(로컬만), 서브넷 2개(data-2a/2c)

---

## 2단계. ECR 리포지토리 생성

1. 검색창 → `ECR` → **Elastic Container Registry**
2. **리포지토리 생성**:
   - 표시 여부: `프라이빗`
   - 이름: `petclinic-was` → **생성**
3. 동일하게:
   - 이름: `petclinic-web` → **생성**

### ECR 수명 주기 정책 (Lifecycle Policy)

> 오래된 이미지를 자동 삭제하여 스토리지 비용을 절감합니다. 커밋마다 이미지가 쌓이므로 주기적 정리 필수.

4. `petclinic-was` 리포지토리 클릭 → **수명 주기 정책** 탭 → **수명 주기 정책 편집**
5. 아래 JSON 붙여넣기:

```json
{
  "rules": [
    {
      "rulePriority": 1,
      "description": "태그 없는 이미지 3일 후 삭제",
      "selection": {
        "tagStatus": "untagged",
        "countType": "sinceImagePushed",
        "countUnit": "days",
        "countNumber": 3
      },
      "action": {"type": "expire"}
    },
    {
      "rulePriority": 2,
      "description": "이미지 최대 30개 유지 (롤백 30회 보장)",
      "selection": {
        "tagStatus": "any",
        "countType": "imageCountMoreThan",
        "countNumber": 30
      },
      "action": {"type": "expire"}
    }
  ]
}
```

> **왜 30개인가**: CodePipeline은 배포 시 `imagedefinitions.json`의 SHA 태그로 ECS 태스크 정의를 업데이트합니다. 실행 중인 태스크는 항상 최신 SHA를 사용하므로 삭제 위험이 없습니다. 단, 롤백 시 오래된 SHA가 필요한데 10개면 10번째 이전 배포로 롤백 불가. 30개면 약 1개월치(일 1회 배포 기준) 롤백 범위 확보. 이미지당 ~400MB, 30개 = 약 $1.2/월 추가 비용.

6. **저장** → `petclinic-web` 리포지토리에도 동일하게 적용

**✅ 2단계 완료 확인**
- ECR → 리포지토리 목록 → `petclinic-was`, `petclinic-web` 2개 존재
- 각 리포지토리 → **수명 주기 정책** 탭 → 규칙 2개 설정됨 (언태그 3일, 최대 30개)

---

## 3단계. IAM 역할 생성

> EC2 Launch Type은 EC2 인스턴스 자체의 역할(인스턴스 프로파일)과 컨테이너 레벨의 역할(Task Execution, Task)이 분리됩니다.
> 배스천 없이 EC2 접속은 SSM(인스턴스 프로파일), 컨테이너 직접 접속은 ECS Exec(Task Role)으로 처리합니다.

### 3-1. EC2 컨테이너 인스턴스 역할 (ECS EC2 인스턴스에 부여)

> ECS Agent가 컨트롤 플레인과 통신하고, ECR 이미지를 Pull하며, CloudWatch로 로그를 전송합니다.
> SSM으로 배스천 없이 콘솔에서 EC2 인스턴스에 직접 접속합니다.

1. IAM → **역할** → **역할 생성**
2. 신뢰할 수 있는 엔터티: `AWS 서비스` → 서비스: `EC2` → **다음**
3. 아래 정책 2개 검색 후 체크:
   - `AmazonEC2ContainerServiceforEC2Role` (ECS Agent 통신 + ECR Pull + CloudWatch 로그)
   - `AmazonSSMManagedInstanceCore` (SSM 콘솔 접속 + 명령 실행)
4. **다음** → 역할 이름: `petclinic-ec2-instance-role` → **역할 생성**

### 3-3. ECS Task Execution Role (에이전트가 컨테이너 밖에서 사용하는 권한)

> ECS Agent가 ECR 이미지 pull, CloudWatch 로그 전송, Secrets 주입에 사용

1. 검색창 → `IAM` → **역할** → **역할 생성**
2. 신뢰할 수 있는 엔터티: `AWS 서비스` → 서비스: `Elastic Container Service`
3. 사용 사례: `Elastic Container Service Task` → **다음**
4. `AmazonECSTaskExecutionRolePolicy` 검색 후 체크 → **다음**
5. 역할 이름: `petclinic-ecs-execution-role` → **역할 생성**
6. 생성된 역할 클릭 → **권한** 탭 → **권한 추가** → **인라인 정책 생성** → **JSON**:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "SecretsManager",
      "Effect": "Allow",
      "Action": "secretsmanager:GetSecretValue",
      "Resource": "*"
    },
    {
      "Sid": "KMS",
      "Effect": "Allow",
      "Action": "kms:Decrypt",
      "Resource": "*"
    }
  ]
}
```

7. 정책 이름: `petclinic-ecs-execution-addpolicy` → **정책 생성**

### 3-4. ECS Task Role (컨테이너 안 애플리케이션 코드가 사용하는 권한)

> 현재는 ECS Exec(배스천 대체 접속)용 권한만 부여. 추후 S3/SQS 등 필요 시 여기에 추가

1. **역할 생성** → `AWS 서비스` → `Elastic Container Service Task` → **다음**
2. 정책 추가 없이 **다음**
3. 역할 이름: `petclinic-ecs-task-role` → **역할 생성**
4. 생성된 역할 → **인라인 정책 생성** → **JSON**:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ECSExec",
      "Effect": "Allow",
      "Action": [
        "ssmmessages:CreateControlChannel",
        "ssmmessages:CreateDataChannel",
        "ssmmessages:OpenControlChannel",
        "ssmmessages:OpenDataChannel"
      ],
      "Resource": "*"
    }
  ]
}
```

5. 정책 이름: `petclinic-ecs-task-addpolicy` → **정책 생성**

### 3-5. CodeBuild Role

1. **역할 생성** → `AWS 서비스` → `CodeBuild` → **다음**
2. 아래 정책 **1개** 검색 후 체크:
   - `AmazonEC2ContainerRegistryPowerUser`
3. **다음** → 역할 이름: `petclinic-codebuild-role` → **역할 생성**
4. 생성된 역할 → **인라인 정책 생성** → **JSON**:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "CloudWatchLogs",
      "Effect": "Allow",
      "Action": [
        "logs:CreateLogGroup",
        "logs:CreateLogStream",
        "logs:PutLogEvents"
      ],
      "Resource": "*"
    },
    {
      "Sid": "S3Artifacts",
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:PutObject",
        "s3:GetObjectVersion",
        "s3:GetBucketAcl",
        "s3:GetBucketLocation"
      ],
      "Resource": "*"
    },
    {
      "Sid": "ECSDescribe",
      "Effect": "Allow",
      "Action": "ecs:DescribeTaskDefinition",
      "Resource": "*"
    },
    {
      "Sid": "STS",
      "Effect": "Allow",
      "Action": "sts:GetCallerIdentity",
      "Resource": "*"
    },
    {
      "Sid": "SecretsManagerRead",
      "Effect": "Allow",
      "Action": [
        "secretsmanager:GetSecretValue",
        "secretsmanager:DescribeSecret"
      ],
      "Resource": "*"
    }
  ]
}
```

5. 정책 이름: `petclinic-codebuild-addpolicy` → **정책 생성**

### 3-6. GitHub Actions Role (OIDC)

**OIDC Provider 등록:**

1. IAM → **자격 증명 공급자** → **공급자 추가**
2. 설정:
   - 공급자 유형: `OpenID Connect`
   - 공급자 URL: `https://token.actions.githubusercontent.com`
   - **지문 가져오기** 클릭
   - 대상: `sts.amazonaws.com`
3. **공급자 추가**

**Role 생성:**

4. **역할 생성** → `웹 자격 증명`
5. 자격 증명 공급자: `token.actions.githubusercontent.com`, 대상: `sts.amazonaws.com`
6. GitHub 필드 입력 (여기서 입력하면 신뢰 정책 자동 생성 — 별도 수정 불필요):
   - **GitHub organization**: 본인 GitHub 계정명 또는 조직명 (예: `csejh1`)
   - **GitHub repository**: 리포지토리 이름 (예: `SmileShark-1week-assignment`)
   - **GitHub branch**: `master`
7. **다음** → 정책 추가 없이 **다음** → 역할 이름: `petclinic-github-actions-role` → **역할 생성**

> 역할 생성 후 **신뢰 관계** 탭에서 `sub` 조건이 `repo:<계정>/<레포>:ref:refs/heads/master` 형태로 자동 생성되어 있는지 확인만 하면 됩니다.

**Permission Policy 추가:**

8. **권한** 탭 → **인라인 정책 생성** → **JSON**:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "CodePipelineTrigger",
      "Effect": "Allow",
      "Action": "codepipeline:StartPipelineExecution",
      "Resource": "*"
    },
    {
      "Sid": "S3Frontend",
      "Effect": "Allow",
      "Action": [
        "s3:PutObject",
        "s3:DeleteObject",
        "s3:ListBucket"
      ],
      "Resource": "*"
    },
    {
      "Sid": "CloudFrontInvalidation",
      "Effect": "Allow",
      "Action": "cloudfront:CreateInvalidation",
      "Resource": "*"
    }
  ]
}
```

9. 정책 이름: `petclinic-github-actions-policy` → **정책 생성**
10. 역할 ARN 메모: `arn:aws:iam::<ACCOUNT_ID>:role/petclinic-github-actions-role`

**✅ 3단계 완료 확인**
- IAM → 역할 검색창에 `petclinic` 입력 → 아래 **5개** 역할 모두 존재:
  `petclinic-ec2-instance-role` / `petclinic-ecs-execution-role` / `petclinic-ecs-task-role` / `petclinic-codebuild-role` / `petclinic-github-actions-role`
  > CodePipeline 서비스 역할은 14단계 파이프라인 생성 시 자동으로 만들어지므로 여기서 확인하지 않습니다.
- IAM → **자격 증명 공급자** → `token.actions.githubusercontent.com` 존재
- `petclinic-ecs-execution-role` → 권한 탭 → `AmazonECSTaskExecutionRolePolicy` + `petclinic-ecs-execution-addpolicy` 2개 확인
- `petclinic-github-actions-role` → 신뢰 관계 탭 → `repo:<계정>/<레포>:ref:refs/heads/master` 조건 자동 생성됨 확인

---

## 4단계. S3 버킷 생성

### 4-1. 프론트엔드 버킷

1. 검색창 → `S3` → **버킷 만들기**
2. 설정:
   - 이름: `petclinic-frontend-<임의숫자>` (전 세계 고유)
   - 리전: `ap-northeast-2`
   - 퍼블릭 액세스 차단: **모두 체크 유지** (CloudFront OAC 사용)
3. **버킷 만들기** → 이름 메모

**✅ 4단계 완료 확인**
- S3 → `petclinic-frontend-<숫자>` 버킷 존재
- 버킷 → 권한 탭 → 퍼블릭 액세스 차단 **모두 활성화** 확인
- 리전 `ap-northeast-2` 확인

> 파이프라인 아티팩트 버킷(`codepipeline-ap-northeast-2-*`)은 14단계 CodePipeline 생성 시 자동으로 만들어집니다.

---

## 5단계. 보안 그룹 생성 (임시 전체 허용)

> 보안 그룹 간 상호 참조(alb-sg → web-sg → was-sg 등) 때문에 처음에 모두 전체 허용으로 만든 뒤, 배포 완료 후 22단계에서 일괄 잠급니다.

검색창 → `VPC` → 왼쪽 메뉴 **보안 그룹**

아래 5개를 순서대로 생성합니다. 모든 보안 그룹 공통 설정:
- VPC: `petclinic-vpc`
- 인바운드 규칙: `모든 트래픽` / 소스: `0.0.0.0/0` (임시)
- 아웃바운드: 기본값 유지 (모든 트래픽 허용)

| 순서 | 이름 | 용도 |
|------|------|------|
| 1 | `petclinic-alb-sg` | ALB |
| 2 | `petclinic-web-sg` | ECS WEB 컨테이너 |
| 3 | `petclinic-was-sg` | ECS WAS 컨테이너 |
| 4 | `petclinic-ec2-sg` | ECS EC2 인스턴스 |
| 5 | `petclinic-rds-sg` | RDS |

**✅ 5단계 완료 확인**
- VPC → 보안 그룹 → 검색창 `petclinic` → 5개 보안 그룹 확인: `alb-sg`, `web-sg`, `was-sg`, `ec2-sg`, `rds-sg`
- 모든 보안 그룹 VPC가 `petclinic-vpc`
- 인바운드: 모든 트래픽 `0.0.0.0/0` (임시 — 22단계에서 잠금)

---

## 6단계. Secrets Manager 설정

> **이 단계는 별도 작업 없습니다.** Secrets Manager 시크릿은 7단계 RDS 생성 시 AWS가 자동으로 만들어 줍니다.

RDS가 자동 생성하는 시크릿 구조:

| 키 | 값 |
|----|----|
| `username` | RDS 마스터 사용자 이름 |
| `password` | AWS가 자동 생성한 안전한 랜덤 비밀번호 |
| `host` | RDS 엔드포인트 |
| `port` | 3306 |
| `dbname` | petclinic |
| `engine` | mysql |

> ECS Task Definition에서는 이 중 `username`, `password` 키만 참조합니다. `host`는 `DB_URL` 환경변수에 직접 입력합니다.

**✅ 6단계**: 7단계 RDS 생성 완료 후 Secrets Manager에서 자동 생성된 시크릿 확인

---

## 7단계. RDS 생성

> Private Subnet에 배치하여 인터넷에 직접 노출되지 않습니다.
> AWS 관리형 KMS(`aws/rds`)로 저장 데이터를 자동 암호화합니다.

### 7-1. DB 서브넷 그룹 생성

> **3-tier 아키텍처**: RDS는 1단계에서 생성한 전용 Data 서브넷(petclinic-data-2a/2c)에 배치합니다.
> Data 서브넷은 라우팅 테이블에 인터넷 경로가 없어 RDS가 외부와 통신하는 경로 자체가 없습니다.
> **Multi-AZ 조건**: data-2a + data-2c — 2개 AZ로 Multi-AZ RDS 지원.

1. 검색창 → `RDS` → 왼쪽 메뉴 **서브넷 그룹** → **DB 서브넷 그룹 생성**
2. 설정:
   - 이름: `petclinic-db-subnet-group`
   - 설명: `PetClinic RDS Data Subnets`
   - VPC: `petclinic-vpc`
3. **가용 영역 추가**: `ap-northeast-2a`, `ap-northeast-2c` 선택
4. **서브넷 추가**: `petclinic-data-2a` (10.0.21.0/24), `petclinic-data-2c` (10.0.22.0/24) 선택
5. **생성**

### 7-2. RDS 인스턴스 생성

1. RDS → **데이터베이스** → **데이터베이스 생성**
2. **엔진 옵션**:
   - 엔진 유형: `MySQL`
   - 엔진 버전: `MySQL 8.0` (최신 마이너 버전)
3. **템플릿**: `개발/테스트`
4. **설정**:
   - DB 인스턴스 식별자: `petclinic-db`
   - 마스터 사용자 이름: `petclinic_admin`
   - 자격 증명 관리: **AWS Secrets Manager에서 관리** 선택
     → AWS가 랜덤 비밀번호를 생성하고 Secrets Manager에 자동 저장
5. **인스턴스 구성**:
   - DB 인스턴스 클래스: `버스터블 클래스` → `db.t3.micro`
6. **스토리지**:
   - 스토리지 유형: `범용 SSD(gp3)`
   - 할당된 스토리지: `20` GiB
   - **스토리지 암호화**: 활성화
   - AWS KMS 키: `aws/rds` (AWS 관리형, 기본값)
7. **연결**:
   - VPC: `petclinic-vpc`
   - DB 서브넷 그룹: `petclinic-db-subnet-group`
   - 퍼블릭 액세스: `아니요`
   - VPC 보안 그룹: `petclinic-rds-sg` (기존 보안 그룹 제거 후 선택)
   - 가용 영역: `ap-northeast-2a`
8. **추가 구성**:
   - 초기 데이터베이스 이름: `petclinic`
   - 자동 백업: 활성화 (보존 기간 7일)
   - 로그 내보내기: `오류 로그`, `일반 로그`, `슬로우 쿼리 로그` 체크
9. **데이터베이스 생성** 클릭

> 생성 완료까지 약 5~10분 소요.

### 7-3. 생성 완료 후 정보 메모

10. RDS → `petclinic-db` 클릭 → **엔드포인트** 메모
    - 형식: `petclinic-db.xxxxxxxxxx.ap-northeast-2.rds.amazonaws.com`
11. Secrets Manager 콘솔 → 자동 생성된 시크릿 클릭 → **보안 암호 ARN** 메모
    - 이름 형식: `rds!db-petclinic-db-xxxxxxxx`
    - ARN 형식: `arn:aws:secretsmanager:ap-northeast-2:<ACCOUNT_ID>:secret:rds!db-petclinic-db-xxxxxxxx`

> **DB 스키마 자동 초기화**: WAS 컨테이너가 처음 시작되면 Spring Boot가 `initDB.sql`(테이블 생성) → `populateDB.sql`(샘플 데이터 삽입)을 자동 실행합니다. 수동 명령 불필요.

**✅ 7단계 완료 확인**
- RDS → 데이터베이스 → `petclinic-db` 상태 `사용 가능`
- `petclinic-db` 클릭 → 연결 → 퍼블릭 액세스 `아니요`, 보안 그룹 `petclinic-rds-sg` 확인
- 연결 → 서브넷 그룹 `petclinic-db-subnet-group` → 서브넷 `data-2a`, `data-2c` 확인
- 엔드포인트 메모 완료
- 스토리지 → 암호화: 활성화됨, KMS 키: `aws/rds` 확인
- Secrets Manager → `rds!db-petclinic-db-*` 시크릿 자동 생성됨, `username` / `password` / `host` 키 포함 확인
- **보안 암호 ARN 메모 완료** (11단계 Task Definition에서 사용)

---

## 8단계. ALB 및 대상 그룹 생성

> 검색창 → `EC2` → 왼쪽 메뉴 **대상 그룹**

### 대상 그룹 생성

1. **대상 그룹 생성**:
   - 대상 유형: `IP 주소`
   - 이름: `petclinic-web-tg`
   - 프로토콜: `HTTP`, 포트: `80`
   - VPC: `petclinic-vpc`
   - 상태 확인 경로: `/health`
2. **다음** → 대상 등록 없이 **대상 그룹 생성**

### ALB 생성

3. 왼쪽 메뉴 **로드 밸런서** → **로드 밸런서 생성** → `Application Load Balancer` → **생성**
4. 설정:
   - 이름: `petclinic-alb`
   - 체계: `인터넷 경계`
   - VPC: `petclinic-vpc`
   - 가용 영역: `petclinic-public-2a`, `petclinic-public-2c` 모두 체크
   - 보안 그룹: `petclinic-alb-sg` (기본 보안 그룹 제거)
   - 리스너 HTTP:80 → 대상 그룹: `petclinic-web-tg`
5. **로드 밸런서 생성** → ALB DNS 이름 메모

**✅ 8단계 완료 확인**
- EC2 → 대상 그룹 → `petclinic-web-tg` 존재, 대상 유형 `IP`, 상태 확인 경로 `/health`
- EC2 → 로드 밸런서 → `petclinic-alb` 상태 `Active`
- `petclinic-alb` → 리스너 탭 → HTTP:80 → 대상 그룹 `petclinic-web-tg` 연결됨
- `petclinic-alb` → 가용 영역: ap-northeast-2a, ap-northeast-2c 2개 확인
- ALB DNS 이름 메모 완료 (`petclinic-alb-xxx.ap-northeast-2.elb.amazonaws.com`)

---

## 9단계. ECS 클러스터 생성 (EC2 Launch Type)

> **AMI를 직접 만들지 않습니다**: ECS EC2 Launch Type은 AWS가 제공하는 ECS 최적화 Amazon Linux 2023 AMI를 자동 사용합니다.
> 애플리케이션 코드는 Dockerfile로 빌드한 Docker 이미지(ECR 저장)로 배포됩니다. EC2 AMI에 앱을 굽는 방식이 아닙니다.
> EC2 인스턴스는 ECS Agent만 실행하고, 실제 앱은 컨테이너(Task)로 올라옵니다.

1. 검색창 → `ECS` → **클러스터** → **클러스터 생성**

**클러스터 구성:**

2. 클러스터 이름: `petclinic-cluster`

**인프라 (컴퓨팅 용량 확보 방법 선택):**

3. `Fargate 및 자체 관리형 인스턴스` 선택
   > Fargate 체크박스는 그대로 두고, EC2 자체 관리형 인스턴스를 추가하는 옵션

**Auto Scaling 그룹(ASG):**

4. `새 Auto Scaling 그룹 생성 - 고급` 선택
5. 프로비저닝 모델: `온디맨드`
6. 컨테이너 인스턴스 AMI: `Amazon Linux 2023` (기본값 유지)
7. EC2 인스턴스 유형: `t3.medium`
8. EC2 인스턴스 역할: **기존 역할 선택** → `petclinic-ec2-instance-role`
   > "기본 역할 생성" / "새 인스턴스 프로파일 생성" 선택하지 말 것 — 3단계에서 이미 생성한 역할 사용
9. 원하는 용량: 최솟값 `1`, 최댓값 `4`
10. SSH 키 페어: `없음 – SSH를 사용할 수 없음`
    > EC2 접속은 SSM 세션 관리자로 처리하므로 SSH 불필요
11. 루트 EBS 볼륨 크기: `30` GiB

**네트워크 설정:**

12. VPC: `petclinic-vpc`
13. 서브넷: `petclinic-private-2a`, `petclinic-private-2c` 모두 선택
14. 보안 그룹: **기존 보안 그룹 선택** → `petclinic-ec2-sg`
15. 퍼블릭 IP 자동 지정: `비활성화`

**모니터링 - 선택 사항:**

16. Container Insights: `Container Insights` 선택 (중간 옵션)
    > "향상된 관찰성" 은 태스크/컨테이너 단위 상세 지표를 추가 제공하지만 비용이 더 발생합니다. 클러스터·서비스 수준 지표만으로도 충분합니다.
17. ECS Exec용 로깅: `기본값` 선택
    > Task Definition에 설정한 awslogs 드라이버로 CloudWatch에 자동 전송됩니다.
18. KMS 암호화 (관리형 스토리지 / Fargate 임시 스토리지): **비워두기**
    > EC2 Launch Type이므로 Fargate 임시 스토리지 항목은 무관합니다.

19. **생성**

**✅ 9단계 완료 확인**
- ECS → 클러스터 → `petclinic-cluster` 상태 `Active`
- `petclinic-cluster` → **ECS 인스턴스** 탭 → `t3.medium` 인스턴스 1개 `ACTIVE` 상태
- EC2 → 인스턴스 → ECS가 자동 시작한 인스턴스 존재 (이름 태그: `ECS Instance - petclinic-cluster`)
- 해당 EC2 인스턴스 → IAM 역할: `petclinic-ec2-instance-role` 확인
- `petclinic-cluster` → 모니터링 탭 → Container Insights: `Container Insights` 확인

---

## 10단계. CloudWatch 로그 그룹 및 알람 생성

### 로그 그룹

1. 검색창 → `CloudWatch` → 왼쪽 메뉴 **로그 그룹** → **로그 그룹 생성**
2. 이름: `/ecs/petclinic-was` → **생성**
3. 이름: `/ecs/petclinic-web` → **생성**

### CloudWatch 알람 (기본 4개)

> **경보** → **경보 생성** 으로 각각 생성합니다.

**① WAS CPU 사용률**
4. 지표 선택: `ECS` → `ClusterName, ServiceName` → `petclinic-cluster / petclinic-was-svc / CPUUtilization`
5. 조건: `80%` 초과 / 기간: `5분`
6. 알람 이름: `petclinic-was-cpu-high`

**② WEB CPU 사용률**
7. 동일하게 `petclinic-web-svc / CPUUtilization` 선택
8. 알람 이름: `petclinic-web-cpu-high`

**③ ALB 5xx 에러**
9. 지표 선택: `ApplicationELB` → `LoadBalancer` → `petclinic-alb / HTTPCode_Target_5XX_Count`
10. 조건: `10` 초과 / 기간: `5분`
11. 알람 이름: `petclinic-alb-5xx-high`

**④ RDS CPU 사용률**
12. 지표 선택: `RDS` → `DBInstanceIdentifier` → `petclinic-db / CPUUtilization`
13. 조건: `80%` 초과 / 기간: `5분`
14. 알람 이름: `petclinic-rds-cpu-high`

### CloudWatch 대시보드

> 주요 지표를 한 화면에서 모니터링합니다. 장애 대응 시 바로 열어보는 뷰.

15. CloudWatch → 왼쪽 메뉴 **대시보드** → **대시보드 생성**
16. 이름: `petclinic-dashboard` → **생성**
17. **위젯 추가** → **선 그래프**로 아래 지표 순서대로 추가:

| 위젯 이름 | 네임스페이스 | 지표 | 차원 |
|----------|------------|------|------|
| WAS CPU | ECS | CPUUtilization | Cluster=petclinic-cluster, Service=petclinic-was-svc |
| WEB CPU | ECS | CPUUtilization | Cluster=petclinic-cluster, Service=petclinic-web-svc |
| ALB 요청 수 | ApplicationELB | RequestCount | LoadBalancer=petclinic-alb |
| ALB 5xx | ApplicationELB | HTTPCode_Target_5XX_Count | LoadBalancer=petclinic-alb |
| RDS CPU | RDS | CPUUtilization | DBInstanceIdentifier=petclinic-db |

18. **숫자(Number)** 위젯으로 추가:

| 위젯 이름 | 지표 |
|----------|------|
| WAS 실행 태스크 수 | ECS / petclinic-was-svc / RunningTaskCount |
| WEB 실행 태스크 수 | ECS / petclinic-web-svc / RunningTaskCount |

19. **대시보드 저장**

**✅ 10단계 완료 확인**
- CloudWatch → 로그 그룹 → `/ecs/petclinic-was`, `/ecs/petclinic-web` 2개 존재
- CloudWatch → 경보 → `petclinic-*` 검색 → 4개 경보 존재 (상태 `데이터 부족`은 정상)
- CloudWatch → 대시보드 → `petclinic-dashboard` 존재 → 클릭 시 위젯 표시 확인

---

## 11단계. ECS Task Definition 생성

### 11-1. WAS Task Definition

1. ECS → **태스크 정의** → **새 태스크 정의 생성**

**태스크 정의 구성:**

2. 태스크 정의 패밀리: `petclinic-was`

**인프라 요구 사항:**

3. 시작 유형: `AWS EC2 인스턴스`
4. 네트워크 모드: `awsvpc`
5. 태스크 역할: `petclinic-ecs-task-role`
6. 태스크 실행 역할: `petclinic-ecs-execution-role`
7. 태스크 크기:
   - CPU: `0.5 vCPU`
   - 메모리: `1 GB`

**컨테이너 추가:**

8. 컨테이너 이름: `petclinic-was`
9. 이미지 URI: `<ACCOUNT_ID>.dkr.ecr.ap-northeast-2.amazonaws.com/petclinic-was:latest`

**포트 매핑:**

10. 컨테이너 포트: `9966` / 프로토콜: `TCP` / 포트 이름: `was` / 앱 프로토콜: `HTTP`

**환경 변수:**

11. **환경 변수** 섹션 → 아래 2개 추가 (유형: `값`):

    | 키 | 값 |
    |----|----|
    | `SPRING_PROFILES_ACTIVE` | `mysql,spring-data-jpa` |
    | `DB_URL` | `jdbc:mysql://<7단계 RDS 엔드포인트>:3306/petclinic?useUnicode=true` |

12. **환경 변수** 섹션 → 아래 2개 추가 (유형: `ValueFrom` — Secrets Manager에서 주입):

    | 키 | 값 |
    |----|----|
    | `DB_USERNAME` | `<7단계 메모한 SECRET_ARN>:username::` |
    | `DB_PASSWORD` | `<7단계 메모한 SECRET_ARN>:password::` |

    > `ValueFrom` 형식: ARN 뒤에 `:username::` 처럼 키 이름을 콜론으로 감쌉니다.

**상태 확인 (헬스체크):**

13. 상태 확인 켜기 → 아래 설정:
    - 명령: `CMD-SHELL, curl -sf http://localhost:9966/petclinic/api/vets > /dev/null || exit 1`
    - 간격: `30`초
    - 제한 시간: `10`초
    - 시작 기간: `60`초 (JVM + DB 초기화 유예 시간)
    - 재시도: `3`

**로그 수집:**

14. 로그 수집 켜기 → `Amazon CloudWatch` 선택:
    - 로그 그룹: `/ecs/petclinic-was`
    - 리전: `ap-northeast-2`
    - 스트림 접두사: `ecs`

15. **생성**

---

### 11-2. WEB Task Definition

1. **새 태스크 정의 생성**

**태스크 정의 구성:**

2. 태스크 정의 패밀리: `petclinic-web`

**인프라 요구 사항:**

3. 시작 유형: `AWS EC2 인스턴스`
4. 네트워크 모드: `awsvpc`
5. 태스크 역할: `petclinic-ecs-task-role`
6. 태스크 실행 역할: `petclinic-ecs-execution-role`
7. 태스크 크기:
   - CPU: `0.25 vCPU`
   - 메모리: `0.5 GB`

**컨테이너 추가:**

8. 컨테이너 이름: `petclinic-web`
9. 이미지 URI: `<ACCOUNT_ID>.dkr.ecr.ap-northeast-2.amazonaws.com/petclinic-web:latest`

**포트 매핑:**

10. 컨테이너 포트: `80` / 프로토콜: `TCP`

**로그 수집:**

11. 로그 수집 켜기 → `Amazon CloudWatch` 선택:
    - 로그 그룹: `/ecs/petclinic-web`
    - 리전: `ap-northeast-2`
    - 스트림 접두사: `ecs`

12. **생성**

**✅ 11단계 완료 확인**
- ECS → 태스크 정의 → `petclinic-was`, `petclinic-web` 각각 리비전 1 존재
- `petclinic-was` 리비전 클릭 → **JSON** 탭 → `secrets` 필드에 `DB_USERNAME`, `DB_PASSWORD` 확인
- `petclinic-was` → `DB_URL` 환경변수 값에 7단계 RDS 엔드포인트 포함 확인
- `petclinic-was` → `healthCheck.startPeriod` = 60 확인

---

## 12단계. CodeBuild 프로젝트 생성

> 검색창 → `CodeBuild` → **빌드 프로젝트 생성**

### 12-1. WAS 빌드 프로젝트

1. 프로젝트 이름: `petclinic-was-build`
2. 프로젝트 유형: `기본 프로젝트`

**소스:**

3. 소스 공급자: `GitHub`
4. 자격 증명: "계정이 AWS 관리형 GitHub 앱을 사용해 연결되었습니다" 표시되면 추가 작업 없음
   > 표시 안 되면 **기본 소스 자격 증명 관리** 클릭 → `GitHub 앱` 선택 → **새 GitHub 연결 생성** → GitHub 로그인/승인 → **Install & Authorize**
5. 리포지토리: `내 GitHub 계정의 리포지토리` 선택 → `https://github.com/csejh1/SmileShark-1week-assignment.git`
6. 소스 버전: **비워두기** (master 기본 사용)
7. **Webhook(기본 소스 Webhook 이벤트)**: `코드 변경이 이 리포지토리에 푸시될 때마다 다시 빌드` → **체크 해제**
   > CodePipeline이 트리거하므로 CodeBuild 직접 Webhook 불필요

**환경:**

8. 환경 이미지: `관리형 이미지`
9. 실행 모드: `컨테이너`
10. 운영 체제: `Amazon Linux`
11. 런타임: `Standard`
12. 이미지: `aws/codebuild/amazonlinux-x86_64-standard:6.0` (최신 버전 선택)
13. 이미지 버전: `이 런타임 버전에 항상 최신 이미지 사용`
14. 서비스 역할: `기존 서비스 역할` 선택 → 역할 이름: `petclinic-codebuild-role`
    > 기본값이 "새 서비스 역할"이므로 반드시 `기존 서비스 역할`로 변경
15. **추가 구성** 펼치기 → **권한이 있음**: **체크** (Docker 이미지 빌드 필수)
16. 컴퓨팅: `3GB 메모리, vCPU 2개` (기본값)

**Buildspec:**

17. `buildspec 파일 사용` 선택
18. Buildspec 이름: `spring-petclinic-reactjs/buildspec.yml`

**아티팩트:**

19. 유형: `아티팩트 없음`

**로그:**

20. CloudWatch: 기본 활성화 유지 (그룹 이름 비워두면 `/aws/codebuild/petclinic-was-build` 자동 생성)

21. **빌드 프로젝트 생성**

### 12-2. WEB 빌드 프로젝트

1. 프로젝트 이름: `petclinic-web-build`
2. 소스/환경: 동일
3. **Buildspec** 이름: `spring-petclinic-reactjs/web/buildspec.yml`
4. **아티팩트**: `아티팩트 없음`
5. **생성**

**✅ 12단계 완료 확인**
- CodeBuild → 빌드 프로젝트 → `petclinic-was-build`, `petclinic-web-build` 2개 존재
- `petclinic-was-build` → buildspec: `spring-petclinic-reactjs/buildspec.yml`, 서비스 역할: `petclinic-codebuild-role`, 권한 있음(Privileged): **활성화** 확인
- `petclinic-web-build` → buildspec: `spring-petclinic-reactjs/web/buildspec.yml` 확인

---

## 13단계. CodePipeline 생성 (Source + Build 스테이지만)

> Deploy 스테이지는 ECS Service가 존재해야 설정 가능합니다. 15단계에서 Service 생성 후 16단계에서 추가합니다.

검색창 → `CodePipeline` → **파이프라인 생성**

### 13-1. WAS 파이프라인

1. 파이프라인 이름: `petclinic-was-pipeline`
2. 실행 모드: `대체됨`
3. 서비스 역할: `새 서비스 역할` 선택 → 역할 이름 자동 입력됨 (수정 불필요)
4. **다음**

5. **소스 스테이지**:
   - 소스 공급자: `GitHub(버전 2)`
   - 연결: **연결** 드롭다운 → 12단계에서 생성한 `petclinic-github` 선택
   - 리포지토리 이름: `<GitHub계정명>/SmileShark-1week-assignment`
   - 기본 브랜치: `master`
   - **파이프라인 자동 시작**: **체크 해제** (GitHub Actions가 트리거)
6. **다음**

7. **빌드 스테이지**:
   - 빌드 공급자: `AWS CodeBuild`
   - 프로젝트 이름: `petclinic-was-build`
8. **다음**

9. **배포 스테이지**: `배포 스테이지 건너뛰기` 클릭
10. **파이프라인 생성**

### 13-2. WEB 파이프라인

동일하게 생성, 아래만 다름:
- 파이프라인 이름: `petclinic-web-pipeline`
- 빌드 프로젝트: `petclinic-web-build`
- 배포 스테이지: 동일하게 건너뛰기

**✅ 13단계 완료 확인**
- CodePipeline → `petclinic-was-pipeline`, `petclinic-web-pipeline` 2개 존재
- 각 파이프라인 스테이지: **Source → Build** 2단계만 존재 (Deploy 없음)
- 각 파이프라인 → **설정** → 파이프라인 자동 시작: **비활성화** 확인

---

## 14단계. 첫 빌드 수동 실행 (ECR 이미지 확보)

> ECS Service를 생성하려면 ECR에 이미지가 있어야 합니다. 여기서 빌드만 수동으로 실행해 이미지를 ECR에 올립니다.

### 14-1. WAS 빌드 실행

1. CodePipeline → `petclinic-was-pipeline` → **지금 릴리스** 클릭
2. Source → Build 순서로 진행 확인 (약 5~10분)
3. Build 스테이지 **성공** 확인
4. ECR → `petclinic-was` 리포지토리 → 이미지 목록에 SHA 태그 이미지 존재 확인

### 14-2. WEB 빌드 실행

5. CodePipeline → `petclinic-web-pipeline` → **지금 릴리스** 클릭
6. Build 스테이지 **성공** 확인
7. ECR → `petclinic-web` → 이미지 존재 확인

**✅ 14단계 완료 확인**
- ECR → `petclinic-was` → 이미지 목록에 `latest` 및 SHA 태그 이미지 존재
- ECR → `petclinic-web` → 동일하게 이미지 존재
- 두 파이프라인 모두 Build 스테이지 ✅ 성공

---

## 15단계. ECS Service 생성

### 15-1. WAS Service

1. ECS → `petclinic-cluster` → **서비스** 탭 → **생성**

2. **서비스 세부 정보**:
   - 태스크 정의 패밀리: `petclinic-was`
   - 태스크 정의 개정: 빈 칸 유지 (최신 자동 선택)
   - 서비스 이름: `petclinic-was-svc`
   - 환경: `Amazon EC2` / 기존 클러스터: `petclinic-cluster`

3. **컴퓨팅 구성 - 고급**:
   - 컴퓨팅 옵션: **용량 공급자 전략** 선택
   - 용량 공급자 전략: **클러스터 기본값 사용** 선택
     > 9단계에서 생성한 ASG Capacity Provider가 자동으로 연결됨. 시작 유형(EC2) 직접 선택 불필요.

4. **배포 구성**:
   - 스케줄링 전략: **복제본**
   - 원하는 태스크: `2` (2개 AZ에 각 1개씩 배치)
   - 가용 영역 리밸런싱: **켜기** (기본값 유지)
   - 상태 검사 유예 기간: 빈 칸 (WAS는 ALB 없으므로 불필요)
   - 배포 컨트롤러 유형: `ECS`
   - 배포 전략: **롤링 업데이트**
   - 최소 실행 작업 비율: `100` (기본값 유지)
   - 최대 실행 작업 비율: `200` (기본값 유지)
   - **배포 실패 감지**:
     - **Amazon ECS 배포 회로 차단기 사용** → 체크
     - **실패 시 롤백** → 체크

5. **네트워킹**:
   - VPC: `petclinic-vpc`
   - 서브넷: `petclinic-pri-sub-1` (ap-northeast-2a), `petclinic-pri-sub-2` (ap-northeast-2c)
   - 보안 그룹: `petclinic-was-sg`

6. **서비스 연결 (Service Connect)**:
   - **서비스 연결 사용** → 체크
   - 서비스 연결 구성: **클라이언트 및 서버** 선택
   - 네임스페이스: **새 네임스페이스 생성** 선택 → 우측 **새 네임스페이스 생성** 버튼 클릭
     - 새 창에서 네임스페이스 설정:
       - 네임스페이스 이름: `petclinic-ns`
       - 설명: 빈 칸 (선택 사항)
       - **인스턴스 검색: `API 호출` 선택** (DNS 쿼리 불필요, 추가 요금 없음)
     - **생성** 클릭 후 창 닫기
   - **포트 매핑 및 애플리케이션 추가** 클릭:
     | 항목 | 값 |
     |------|----|
     | 포트 이름 | `was` |
     | 검색 이름 | `was` |
     | 포트 | `9966` |

7. 나머지 섹션 (서비스 검색, VPC Lattice, 서비스 자동 크기 조정) → **기본값 유지 (사용 안 함)**

8. **생성** 클릭

---

### 15-2. WEB Service

1. ECS → `petclinic-cluster` → **서비스** 탭 → **생성**

2. **서비스 세부 정보**:
   - 태스크 정의 패밀리: `petclinic-web`
   - 태스크 정의 개정: 빈 칸 유지 (최신 자동 선택)
   - 서비스 이름: `petclinic-web-svc`
   - 환경: `Amazon EC2` / 기존 클러스터: `petclinic-cluster`

3. **컴퓨팅 구성 - 고급**:
   - 컴퓨팅 옵션: **용량 공급자 전략** 선택
   - 용량 공급자 전략: **클러스터 기본값 사용** 선택

4. **배포 구성**:
   - 스케줄링 전략: **복제본**
   - 원하는 태스크: `2` (2개 AZ에 각 1개씩 배치)
   - 상태 검사 유예 기간: `60` 초 (ALB 헬스체크가 안정될 때까지 유예)
   - 배포 전략: **롤링 업데이트**
   - 최소/최대 실행 작업 비율: `100` / `200` (기본값 유지)
   - **배포 실패 감지**:
     - **Amazon ECS 배포 회로 차단기 사용** → 체크
     - **실패 시 롤백** → 체크

5. **네트워킹**:
   - VPC: `petclinic-vpc`
   - 서브넷: `petclinic-pri-sub-1` (ap-northeast-2a), `petclinic-pri-sub-2` (ap-northeast-2c)
   - 보안 그룹: `petclinic-web-sg`

6. **서비스 연결 (Service Connect)**:
   - **서비스 연결 사용** → 체크
   - 서비스 연결 구성: **클라이언트 측만 해당** 선택
     > WEB은 WAS를 호출하는 클라이언트 역할. 포트 매핑 추가 불필요.
   - 네임스페이스: `petclinic-ns` 선택 (WAS에서 생성한 네임스페이스)

7. **로드 밸런싱 - 선택 사항**:
   - **로드 밸런싱 사용** → 체크
   - 로드 밸런서 유형: `Application Load Balancer`
   - 로드 밸런서: `petclinic-alb`
   - 컨테이너 선택: `petclinic-web 80:80`
   - 리스너: **기존 리스너 사용** → `80:HTTP`
   - 대상 그룹: **기존 대상 그룹 사용** → `petclinic-web-tg`

8. 나머지 섹션 (서비스 검색, VPC Lattice, 서비스 자동 크기 조정) → **기본값 유지 (사용 안 함)**

9. **생성** 클릭

### 15-3. ECS Service Auto Scaling 설정

> ECS 서비스 수준의 태스크 수 자동 조정입니다.
> 대상 추적(Target Tracking) 정책은 **스케일 아웃과 스케일 인을 하나의 정책으로 처리**합니다.
> - 스케일 아웃: CPU가 대상 값(70%) 초과 시 태스크 수 증가
> - 스케일 인: CPU가 대상 값 이하로 충분히 유지되면 태스크 수 감소
> 9단계 클러스터 생성 시 설정한 ASG(최솟값 1, 최댓값 4)가 기반이 되며, Capacity Provider가 자동으로 연동됩니다.

**WAS 서비스 Auto Scaling:**

1. ECS → `petclinic-cluster` → **서비스** 탭 → `petclinic-was-svc` 클릭 → **업데이트**
2. **서비스 Auto Scaling** 섹션:
   - **서비스 Auto Scaling 사용** → 체크
   - 원하는 태스크 최솟값: `2` (2개 AZ HA 유지)
   - 원하는 태스크 최댓값: `4`
3. **정책 추가** 클릭:
   - 조정 유형: `대상 추적`
   - 정책 이름: `petclinic-was-cpu-scaling`
   - ECS 서비스 지표: `ECSServiceAverageCPUUtilization`
   - 대상 값: `70`
   - **스케일 아웃 쿨다운**: `60`초 (스케일 아웃 후 다음 스케일 아웃까지 대기 시간)
   - **스케일 인 쿨다운**: `300`초 (트래픽 일시 감소에 의한 불필요한 축소 방지)
   - **스케일 인 비활성화**: **체크 해제** (스케일 인 허용)
4. **업데이트**

**WEB 서비스 Auto Scaling:**

5. ECS → `petclinic-cluster` → **서비스** 탭 → `petclinic-web-svc` 클릭 → **업데이트**
6. **서비스 Auto Scaling** 섹션:
   - **서비스 Auto Scaling 사용** → 체크
   - 원하는 태스크 최솟값: `2` (2개 AZ HA 유지)
   - 원하는 태스크 최댓값: `4`
7. **정책 추가** 클릭:
   - 조정 유형: `대상 추적`
   - 정책 이름: `petclinic-web-cpu-scaling`
   - ECS 서비스 지표: `ECSServiceAverageCPUUtilization`
   - 대상 값: `70`
   - **스케일 아웃 쿨다운**: `60`초
   - **스케일 인 쿨다운**: `300`초
   - **스케일 인 비활성화**: **체크 해제** (스케일 인 허용)
8. **업데이트**

**✅ 15단계 완료 확인**
- ECS → `petclinic-cluster` → **서비스** 탭 → `petclinic-was-svc`, `petclinic-web-svc` 2개 상태 `Active`
- 각 서비스 → **태스크** 탭 → 태스크 상태 `RUNNING` 확인
- `petclinic-was-svc` → **구성 및 네트워킹** 탭 → Service Connect 섹션에서 네임스페이스 `petclinic-ns`, 유형 `클라이언트 및 서버` 확인
- `petclinic-web-svc` → **구성 및 네트워킹** 탭 → 로드 밸런서 `petclinic-alb`, 대상 그룹 `petclinic-web-tg` 연결됨 확인
- 각 서비스 → **Auto Scaling** 탭 → 정책 1개 확인

---

## 16단계. CodePipeline Deploy 스테이지 추가

> ECS Service가 생성되었으므로 이제 Deploy 스테이지를 파이프라인에 추가합니다.

### 16-1. WAS 파이프라인 편집

1. CodePipeline → `petclinic-was-pipeline` → **편집**
2. Build 스테이지 아래 **+ 스테이지 추가** 클릭
3. 스테이지 이름: `Deploy`
4. **+ 작업 그룹 추가**:
   - 작업 공급자: `Amazon ECS`
   - 입력 아티팩트: `BuildArtifact`
   - 클러스터 이름: `petclinic-cluster`
   - 서비스 이름: `petclinic-was-svc`
   - 이미지 정의 파일: `imagedefinitions.json`
5. **완료** → **저장**

### 16-2. WEB 파이프라인 편집

6. `petclinic-web-pipeline` → 동일하게 편집
7. Deploy 스테이지 → 서비스 이름: `petclinic-web-svc`
8. **완료** → **저장**

**✅ 16단계 완료 확인**
- 각 파이프라인 스테이지: **Source → Build → Deploy** 3단계 구성 확인
- 각 파이프라인 → **설정** → 서비스 역할: `AWSCodePipelineServiceRole-ap-northeast-2-petclinic-*` 형태로 자동 생성됨 확인

---

## 17단계. CloudTrail 설정

> 누가, 언제, 어떤 AWS API를 호출했는지 감사 로그를 S3에 저장합니다.
> 보안 사고 발생 시 추적 근거가 되며, CloudWatch Logs와 연동하면 실시간 알람도 가능합니다.

### 17-1. CloudTrail용 S3 버킷 생성

1. S3 → **버킷 만들기**:
   - 이름: `petclinic-cloudtrail-<임의숫자>` (전 세계 고유)
   - 리전: `ap-northeast-2`
   - 퍼블릭 액세스 차단: 모두 체크 유지
2. **버킷 만들기**

### 17-2. CloudTrail 생성

3. 검색창 → `CloudTrail` → **추적 생성**
4. 설정:
   - 추적 이름: `petclinic-trail`
   - 스토리지 위치: `기존 S3 버킷 사용` → `petclinic-cloudtrail-<숫자>` 선택
   - 로그 파일 SSE-KMS 암호화: **비활성화** (S3 기본 SSE-S3 암호화 사용)
     > `aws/s3` KMS 키는 CloudTrail에서 사용 불가 — KmsKeyNotFoundException 오류 발생
5. **CloudWatch Logs 연동** (선택 권장):
   - CloudWatch Logs: **활성화**
   - 로그 그룹 이름: `/aws/cloudtrail/petclinic`
   - 역할 이름: `CloudTrail_CloudWatchLogs_Role` (자동 생성)
6. **이벤트 유형**:
   - 관리 이벤트: **읽기**, **쓰기** 모두 체크
   - 데이터 이벤트: S3 버킷 `petclinic-frontend-*` 추가 (선택)
7. **추적 생성**

**✅ 15단계 완료 확인**
- S3 → `petclinic-cloudtrail-<숫자>` 버킷 존재
- CloudTrail → 추적 → `petclinic-trail` → 상태 **로깅 중** (녹색)
- `petclinic-trail` → 세부 정보 → 스토리지: `petclinic-cloudtrail-<숫자>`, CloudWatch Logs 그룹 `/aws/cloudtrail/petclinic` 연결됨
- S3 → `petclinic-cloudtrail-<숫자>` → 수분 내 `AWSLogs/` 폴더 생성 여부 확인

---

## 18단계. Route 53 호스팅 영역 생성 및 DNS 등록

> ACM 인증서 DNS 검증과 CloudFront 커스텀 도메인 연결에 필요합니다.
> 도메인이 없으면 Route 53에서 직접 구매하거나 외부 등록 기관(가비아, Namecheap 등)의 도메인을 Route 53으로 연결합니다.

### 18-1. 호스팅 영역 생성

1. 검색창 → `Route 53` → **호스팅 영역** → **호스팅 영역 생성**
2. 설정:
   - 도메인 이름: 보유한 도메인 입력 (예: `example.com`)
   - 유형: **퍼블릭 호스팅 영역**
3. **호스팅 영역 생성**
4. 생성 후 **NS 레코드** 4개 확인 (예: `ns-xxx.awsdns-xx.com`)

### 18-2. 외부 등록 기관 도메인인 경우 — 네임서버 변경

> Route 53에서 도메인을 구매한 경우 이 단계를 건너뜁니다.

1. 도메인 등록 기관(가비아, Namecheap 등) 관리 콘솔 접속
2. 해당 도메인의 **네임서버(NS) 설정** 변경
3. Route 53 호스팅 영역의 NS 레코드 4개를 모두 입력
4. 변경 후 DNS 전파까지 최대 48시간 소요 (보통 수 분~수 시간)

> **전파 확인**: `nslookup -type=NS example.com` 또는 [dnschecker.org](https://dnschecker.org) 에서 확인

### 18-3. Route 53에서 도메인을 구매하는 경우

1. Route 53 → **도메인 등록** → **도메인 등록**
2. 원하는 도메인 검색 → 장바구니 추가 → 결제
3. 구매 완료 시 호스팅 영역이 **자동 생성**됨 (18-1 불필요)

**✅ 18단계 완료 확인**
- Route 53 → 호스팅 영역 → 도메인에 해당하는 영역 존재
- 호스팅 영역 내 **NS 레코드**, **SOA 레코드** 자동 생성됨
- 외부 등록 기관 사용 시: `nslookup -type=NS <도메인>` 결과에 `awsdns` 포함 여부 확인

---

## 19단계. ACM 인증서 발급

> CloudFront용 인증서는 반드시 **버지니아 북부(us-east-1)** 리전에서 발급해야 합니다.

1. 리전을 **`us-east-1` (버지니아 북부)** 으로 변경
2. 검색창 → `Certificate Manager` → **인증서 요청**
3. 설정:
   - 인증서 유형: `퍼블릭 인증서`
   - 도메인 이름: 보유한 도메인 입력 (예: `petclinic.example.com`)
   - 검증 방법: `DNS 검증`
4. **요청** 클릭
5. 인증서 상세 페이지 → **도메인** 섹션 → **Route 53에서 레코드 생성** 클릭
   > 18단계에서 Route 53 호스팅 영역을 만들었으므로 CNAME 레코드가 **자동으로 등록**됩니다.
   > 외부 등록 기관 사용 시: CNAME 이름/값을 복사해 수동 등록 필요
6. 수 분 후 인증서 상태가 `발급됨`으로 변경될 때까지 대기

**✅ 19단계 완료 확인**
- **리전: us-east-1** 확인 (서울 아님)
- ACM → 인증서 목록 → 도메인 이름 확인, 상태 **발급됨(Issued)**
- Route 53 → 호스팅 영역 → CNAME 레코드 자동 생성됨 확인
- 다음 단계 진행 전 **리전을 `ap-northeast-2`로 변경**

---

## 20단계. CloudFront 배포 생성

> ⚠️ **리전을 `ap-northeast-2` (서울)로 반드시 변경 후 진행** — 18~19단계는 us-east-1에서 작업했습니다.
> WAF는 CF 생성 후 21단계에서 연결합니다.

**시크릿 값 생성 (랜덤 UUID):**

메모장에서 UUID를 직접 작성:
`xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx` (예: `a1b2c3d4-e5f6-7890-abcd-ef1234567890`)
→ 이 값을 `<SECRET_VALUE>`로 메모 (21단계 WAF 규칙과 ALB 원본 헤더에 동일하게 사용)

1. 검색창 → `CloudFront` → **배포 생성**

### Origin 1 — S3

2. 원본 도메인: `petclinic-frontend-<숫자>.s3.ap-northeast-2.amazonaws.com`
3. 원본 액세스: `원본 액세스 제어 설정(권장)` → **제어 설정 생성** → **생성**
4. 배포 생성 완료 후 노란 배너가 뜨면 **정책 복사** 클릭 후 메모
   - 배너가 없으면: 배포 → **원본** 탭 → S3 원본 선택 → **편집** → 하단 **정책 복사** 버튼
   - 그래도 없으면 S3 버킷 정책을 아래 형식으로 직접 작성:
     ```json
     {
       "Version": "2012-10-17",
       "Statement": [{
         "Effect": "Allow",
         "Principal": { "Service": "cloudfront.amazonaws.com" },
         "Action": "s3:GetObject",
         "Resource": "arn:aws:s3:::petclinic-frontend-<숫자>/*",
         "Condition": {
           "StringEquals": {
             "AWS:SourceArn": "arn:aws:cloudfront::<계정ID>:distribution/<배포ID>"
           }
         }
       }]
     }
     ```
     - `<계정ID>`: 콘솔 우측 상단 계정 번호
     - `<배포ID>`: CloudFront → 배포 목록 → ID 열 값 (예: `E1ABCD2EFGH3IJ`)

### 기본 캐시 동작

5. 뷰어 프로토콜 정책: `Redirect HTTP to HTTPS`
6. 캐시 정책: `CachingOptimized`
7. 기본 루트 객체: `index.html`

### 커스텀 도메인

8. 대체 도메인(CNAME): 보유 도메인 입력 (예: `www.awsrapa11.cloud`)
9. 커스텀 SSL 인증서: 19단계에서 발급한 인증서 선택

10. **배포 생성** → CloudFront 도메인 메모 (`xxxx.cloudfront.net`)

### Origin 2 — ALB 추가 (커스텀 헤더 포함)

11. 생성된 배포 → **원본** 탭 → **원본 생성**
12. 설정:
    - 원본 도메인: ALB DNS 이름 직접 입력
    - 프로토콜: `HTTP만 해당`, 포트: `80`
    - 원본 이름: `petclinic-alb`
    - **커스텀 헤더 추가**:
      - 헤더 이름: `x-origin-verify`
      - 값: `<SECRET_VALUE>` (이 단계 앞에서 메모한 값)
13. **원본 저장**

### API 동작 추가

14. **동작** 탭 → **동작 생성**:
    - 경로 패턴: `/petclinic/*`
    - 원본: `petclinic-alb`
    - 허용된 HTTP 방법: `GET, HEAD, OPTIONS, PUT, POST, PATCH, DELETE`
    - 캐시 정책: `CachingDisabled`
    - 원본 요청 정책: `AllViewer`
15. **동작 저장**

### S3 버킷 정책 적용

16. S3 → `petclinic-frontend-<숫자>` → **권한** 탭 → **버킷 정책 편집**
17. 기존 내용 전체 삭제 후 4번에서 확보한 OAC 정책 붙여넣기 → **저장**
    > 이 버킷은 CloudFront에서만 접근하므로 OAC 정책 외 다른 정책은 불필요합니다.

**✅ 20단계 완료 확인**
- CloudFront → 배포 목록 → 상태 **활성화됨**
- 배포 → **원본** 탭 → 원본 2개: S3(OAC 적용됨), ALB(`x-origin-verify` 헤더 포함)
- 배포 → **동작** 탭 → `/petclinic/*` → ALB 원본, `/*` → S3 원본

---

## 21단계. WAF 생성 및 연결

> WAF는 두 개를 만듭니다.
> - **ALB WAF** (ap-northeast-2): CloudFront를 거치지 않은 ALB 직접 접근 차단
> - **CF WAF** (us-east-1): CloudFront 앞단에서 공통 웹 공격 차단

---

### 21-1. ALB용 WAF

**리전: `ap-northeast-2` (서울) 확인**

**① 보호 팩(웹 ACL) 생성 화면**

1. 검색창 → `WAF & Shield` → 좌측 메뉴 **Web ACLs** → **Web ACL 생성** 클릭
2. **앱 카테고리**: `기타` 선택
3. **앱 포커스**: `API와 웹 모두` 선택
4. **보호할 리소스 선택**:
   - `Amazon API Gateway REST API, Application Load Balancer, AWS AppSync GraphQL API...` 선택
     > CloudFront 옵션이 아닌 ALB 포함된 두 번째 옵션
5. **초기 보호 기능 선택**: **`필수`** 선택 (직접 구축, 월 $12 수준)
   > 권장/권장 사항은 관리형 규칙이 자동 포함되어 비용이 높음. 여기서는 커스텀 헤더 규칙 하나만 필요하므로 필수 선택
6. **이름**: `petclinic-alb-waf`
7. 로깅 대상: 기본값 유지 (설정 안 해도 무방)
8. **다음** 클릭

**② 규칙 추가**

9. **규칙 추가** 버튼 클릭 → **자체 규칙 및 규칙 그룹 추가** 선택
10. 규칙 유형: **규칙 빌더** 선택 (기본값)
11. 아래 항목 입력:
    - **이름**: `require-cf-secret-header`
    - **유형**: `일반 규칙`
12. **요청이 다음과 같은 경우** 섹션:
    - **검사** 드롭다운 → **`단일 헤더`** 선택
      > 기본값이 "국가에서 시작" 등으로 되어있으면 반드시 변경
    - **헤더 필드 이름**: `x-origin-verify`
    - 바로 아래 조건 드롭다운 → **`문과 일치하지 않음`** 선택
    - **일치 유형**: **`문자열과 정확히 일치`** 선택
    - **값**: `<SECRET_VALUE>` (20단계에서 메모한 UUID)
    - 텍스트 변환: 없음 (기본값)
13. **작업**: `Block`
14. **규칙 추가** 버튼 클릭
15. **다음** 클릭 (우선순위 — 변경 불필요)
16. **다음** 클릭 (지표 — 기본값 유지)
17. **보호 팩(웹 ACL) 생성** 클릭

**③ ALB 연결**

18. 생성된 `petclinic-alb-waf` 클릭 → **연결된 AWS 리소스** 탭
19. **AWS 리소스 추가** 클릭 → `petclinic-alb` 선택 → **추가**

---

### 21-2. CloudFront용 WAF

> **리전을 `us-east-1` (버지니아 북부)로 변경 후 진행**

**① 보호 팩(웹 ACL) 생성 화면**

1. 콘솔 우측 상단 리전 → **미국 동부(버지니아 북부) us-east-1** 변경
2. WAF & Shield → **Web ACLs** → **Web ACL 생성** 클릭
3. **앱 카테고리**: `기타`
4. **앱 포커스**: `웹`
5. **보호할 리소스 선택**:
   - `AWS Amplify 애플리케이션, CloudFront 배포...` 선택 (첫 번째 옵션)
     > 리전이 us-east-1이어야 이 옵션이 활성화됨
6. **초기 보호 기능 선택**: **`필수`** 선택 (직접 구축)
7. **이름**: `petclinic-cf-waf`
8. **다음** 클릭

**② 관리형 규칙 추가**

9. **규칙 추가** 버튼 클릭 → **관리형 규칙 그룹 추가** 선택
10. **AWS 관리형 규칙 그룹** 목록에서:
    - `AWS 코어 규칙 세트 (Core rule set)` → **규칙 그룹에 추가** 클릭
    - `알려진 잘못된 입력 (Known bad inputs)` → **규칙 그룹에 추가** 클릭
11. **규칙 추가** 버튼 클릭
12. **다음** → **다음** (우선순위, 지표 기본값 유지)
13. **보호 팩(웹 ACL) 생성** 클릭

**③ CloudFront 배포 연결**

> WAF 콘솔에서 CloudFront를 연결하면 "AWS WAF couldn't retrieve the resource" 오류가 발생할 수 있습니다.
> **CloudFront 콘솔에서 반대 방향으로 연결**하는 방법을 사용합니다.

14. 리전을 `ap-northeast-2`로 변경
15. CloudFront → 배포 목록 → 해당 배포 클릭
16. **일반** 탭 → **편집** 클릭
17. **AWS WAF 웹 ACL** 항목 → `petclinic-cf-waf` 선택
18. **변경 사항 저장** 클릭

---

**✅ 21단계 완료 확인**
- WAF 콘솔 (ap-northeast-2) → `petclinic-alb-waf` → **연결된 AWS 리소스** 탭 → `petclinic-alb` 연결됨
- `petclinic-alb-waf` → **규칙** 탭 → `require-cf-secret-header`, 작업 `Block` 확인
- WAF 콘솔 (us-east-1) → `petclinic-cf-waf` → **연결된 AWS 리소스** 탭 → CloudFront 배포 연결됨
- CloudFront → 해당 배포 → **일반** 탭 → **AWS WAF 웹 ACL**: `petclinic-cf-waf` 표시됨
- (선택) ALB DNS 직접 접근: `http://<ALB DNS 이름>` → **403 Forbidden** 반환 확인

---

## 22단계. Route 53 레코드 등록 및 코드 수정

### 22-1. Route 53 CloudFront 레코드 등록

> CloudFront 생성(20단계) 후 커스텀 도메인을 연결하는 단계입니다.

1. Route 53 → **호스팅 영역** → `awsrapa11.cloud` 클릭
2. **레코드 생성** 클릭
3. 아래 항목 입력:
   - **레코드 이름**: `www`
   - **레코드 유형**: `A`
   - **별칭**: **켜기** (토글 활성화)
   - **트래픽 라우팅 대상**: `CloudFront 배포에 대한 별칭` 선택
   - **배포 선택**: 20단계에서 생성한 CloudFront 배포 도메인 선택 (`xxxx.cloudfront.net`)
4. **레코드 생성** 클릭

> DNS 전파에 수 분 소요. `nslookup www.awsrapa11.cloud` 로 확인 가능.

---

### 22-2. API URL 코드 수정

`spring-petclinic-reactjs/client/webpack.config.prod.js`:

```js
// 변경 전
__API_SERVER_URL__: JSON.stringify('https://api.rapa11.store/petclinic')

// 변경 후
__API_SERVER_URL__: JSON.stringify('https://www.awsrapa11.cloud/petclinic')
```

**✅ 22단계 완료 확인**
- Route 53 → `awsrapa11.cloud` 호스팅 영역 → `www` A 레코드(별칭) 존재
- `nslookup www.awsrapa11.cloud` → CloudFront IP로 응답
- `webpack.config.prod.js` → `__API_SERVER_URL__` 값이 `https://www.awsrapa11.cloud/petclinic`
- `git diff`로 변경 내용 확인

---

## 23단계. GitHub Actions 워크플로우 설정 및 Secrets 등록

### 23-1. 워크플로우 파일 위치 확인

> GitHub Actions는 **리포지토리 루트**의 `.github/workflows/` 디렉터리만 인식합니다.
> `spring-petclinic-reactjs/.github/workflows/`에 있으면 절대 트리거되지 않습니다.

`aws-deploy.yml`이 아래 경로에 있는지 확인:
```
SmileShark-1week-assignment/
└── .github/
    └── workflows/
        └── aws-deploy.yml   ← 여기 있어야 함
```

이미 올바른 위치에 있으므로 별도 이동 불필요. `git status`로 확인:
```bash
git status
# .github/workflows/aws-deploy.yml 이 untracked 또는 modified로 표시되어야 함
```

### 23-2. GitHub Secrets 등록

GitHub 리포지토리 → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**

| Secret 이름 | 값 | 확인 위치 |
|-------------|-----|----------|
| `AWS_ROLE_ARN` | `arn:aws:iam::<ID>:role/petclinic-github-actions-role` | 3단계 3-6에서 메모한 역할 ARN |
| `S3_BUCKET_NAME` | `petclinic-frontend-<숫자>` | 4단계에서 생성한 버킷 이름 |
| `CF_DISTRIBUTION_ID` | `E1XXXXXXXXXX` | CloudFront 콘솔 → 배포 목록 → ID 열 |

> AWS 자격증명(Access Key / Secret Key)은 저장하지 않습니다. OIDC 방식으로 `AWS_ROLE_ARN`만으로 인증합니다.

**✅ 23단계 완료 확인**
- 리포지토리 루트에 `.github/workflows/aws-deploy.yml` 존재
- GitHub 리포지토리 → **Settings** → **Secrets and variables** → **Actions** → 시크릿 3개 존재:
  `AWS_ROLE_ARN` / `S3_BUCKET_NAME` / `CF_DISTRIBUTION_ID`
- 각 값 오타 확인 (ARN 형식, Distribution ID `E`로 시작)

---

## 24단계. 첫 배포

```bash
git add .
git commit -m "initial deploy"
git push origin master
```

**GitHub Actions 탭 확인:**
- `trigger-backend-pipelines` → CodePipeline 2개 트리거
- `deploy-frontend` → S3 sync + CF invalidation

**AWS CodePipeline 콘솔 확인:**
- `petclinic-was-pipeline`: Source → Build → ECS
- `petclinic-web-pipeline`: Source → Build → ECS

**✅ 21단계 완료 확인**
- GitHub → **Actions** 탭 → 최신 워크플로우 실행 → `trigger-backend-pipelines`, `deploy-frontend` 모두 ✅ 녹색
- CodePipeline → `petclinic-was-pipeline` → Source ✅, Build ✅, Deploy ✅ (총 5~10분 소요)
- CodePipeline → `petclinic-web-pipeline` → 동일하게 전체 성공
- S3 → `petclinic-frontend-<숫자>` → 객체 목록에 `index.html` 등 빌드 파일 존재
- 브라우저 → `https://xxxx.cloudfront.net` → PetClinic 메인 화면 표시
- 브라우저 → `https://xxxx.cloudfront.net/petclinic/api/vets` → JSON 응답 (수의사 목록)
- 브라우저 → `http://petclinic-alb-xxx.elb.amazonaws.com` → **403 Forbidden** (WAF 차단 확인)
- CloudWatch → 로그 그룹 → `/ecs/petclinic-was` → 로그 스트림 존재 및 `HikariPool` 초기화 성공 메시지 확인

---

## 25단계. 보안 그룹 잠금 (최소 권한 적용)

> 서비스 정상 동작 확인 후 5단계에서 임시로 열어둔 보안 그룹 규칙을 최소 권한으로 교체합니다.

검색창 → `VPC` → 왼쪽 메뉴 **보안 그룹**

각 보안 그룹을 클릭 → **인바운드 규칙** 탭 → **인바운드 규칙 편집** → 기존 규칙 삭제 후 아래 규칙으로 교체

### petclinic-alb-sg

| 유형 | 포트 | 소스 |
|------|------|------|
| HTTPS | 443 | `0.0.0.0/0` |
| HTTP | 80 | `0.0.0.0/0` |

### petclinic-web-sg

| 유형 | 포트 | 소스 |
|------|------|------|
| TCP | 80 | `petclinic-alb-sg` |

### petclinic-was-sg

| 유형 | 포트 | 소스 |
|------|------|------|
| TCP | 9966 | `petclinic-web-sg` |

### petclinic-ec2-sg

| 유형 | 포트 | 소스 | 용도 |
|------|------|------|------|
| TCP | 80 | `petclinic-alb-sg` | WEB 컨테이너 고정 포트 |
| TCP | 32768-65535 | `petclinic-alb-sg` | ECS 동적 포트 매핑 |
| TCP | 9966 | `petclinic-ec2-sg` (자기 자신) | Service Connect 내부 통신 |

> SSH(22번) 인바운드는 추가하지 않습니다. EC2 접속은 SSM 세션 관리자로 처리합니다.

### petclinic-rds-sg

| 유형 | 포트 | 소스 |
|------|------|------|
| MySQL/Aurora | 3306 | `petclinic-was-sg` |

**✅ 22단계 완료 확인**
- `petclinic-alb-sg`: 인바운드 443, 80만 존재 (소스 0.0.0.0/0)
- `petclinic-web-sg`: 인바운드 TCP 80, 소스가 `petclinic-alb-sg` **ID** (이름 아님)
- `petclinic-was-sg`: 인바운드 TCP 9966, 소스가 `petclinic-web-sg` **ID**
- `petclinic-ec2-sg`: 인바운드 규칙 3개 (80/32768-65535 from alb-sg, 9966 from ec2-sg 자기 자신)
- `petclinic-rds-sg`: 인바운드 TCP 3306, 소스가 `petclinic-was-sg` **ID**
- 브라우저 → `https://xxxx.cloudfront.net` → 여전히 정상 동작 확인

---

## 배포 후 확인

| 항목 | 확인 방법 |
|------|----------|
| 프론트엔드 | `https://xxxx.cloudfront.net` 브라우저 접속 |
| API | `https://xxxx.cloudfront.net/petclinic/api/vets` |
| ALB 직접 접근 차단 | `http://petclinic-alb-xxx.elb.amazonaws.com/petclinic/api/vets` → 403 반환 확인 |
| 컨테이너 로그 | CloudWatch → 로그 그룹 → `/ecs/petclinic-was` |
| ECS Exec (컨테이너 접속) | ECS 콘솔 → 태스크 → **명령 실행** 탭 |
| EC2 인스턴스 접속 (SSM) | Systems Manager → 세션 관리자 → 인스턴스 선택 → **세션 시작** |
| RDS 연결 확인 | ECS WAS 컨테이너 로그에서 `HikariPool` 연결 성공 메시지 확인 |
| Secrets Manager 주입 확인 | ECS 태스크 → **환경** 탭 → `DB_USERNAME` 존재 확인 |
| CloudWatch 알람 | CloudWatch → 경보 → `petclinic-*` 알람 상태 확인 |
| CloudTrail 로그 | CloudTrail → 이벤트 기록 → API 호출 목록 확인 |

---

## 롤링 배포 동작 방식

CodePipeline이 배포를 시작하면 ECS가 아래 순서로 자동 처리:

```
1. 새 태스크 시작 (새 이미지)
2. 헬스체크 통과 확인
3. ALB에서 새 태스크로 트래픽 전환
4. 기존 태스크 종료
```

배포 중 서비스 중단 없음. 이전 태스크 정의로 돌아가려면:
ECS → 서비스 → **업데이트** → 이전 태스크 정의 리비전 선택

---

## 수정된 파일 요약

| 파일 | 변경 내용 | 이유 |
|------|----------|------|
| `web/nginx.conf` | `location /` placeholder 제거, `resolver` + `$backend` 방식으로 ALB 프록시 | 프론트가 S3/CF 담당, nginx는 API 프록시만. ALB DNS를 환경변수로 주입 (트러블슈팅 #17~19) |
| `web/Dockerfile` | CMD를 `sed` 치환 스크립트로 변경 | 컨테이너 시작 시 `WAS_ALB_DNS` 환경변수로 nginx.conf의 placeholder 치환 |
| `buildspec.yml` | ECR URI STS 동적 취득 | account ID 코드 노출 방지 |
| `web/buildspec.yml` | ECR URI STS 동적 취득, `imagedefinitions.json` 출력 | 롤링 배포 방식에 맞게 (CodeDeploy 아티팩트 제거) |
| `web/appspec.yml` | 미사용 표시 | Blue/Green → Rolling으로 전환, CodeDeploy 불필요 |
| `aws-deploy.yml` | 빌드/배포 제거 → CodePipeline 트리거 + 프론트 배포 | 역할 명확화: 빌드는 CodeBuild, 배포는 ECS |
| `client/webpack.config.prod.js` | API URL → CF 도메인 | 실제 배포 도메인으로 교체 |
| `db/mysql/initDB.sql` | CREATE DATABASE / GRANT / USE 3줄 제거 | RDS에서 불필요 + MySQL 8.0 GRANT 문법 오류 발생 |
| `application-mysql.properties` | `spring.sql.init.mode=always` 등 주석 해제 | WAS 최초 기동 시 DB 스키마/데이터 자동 초기화 |

---

## 트러블슈팅

실제 배포 중 발생한 문제와 해결 방법 모음.

---

### 1. CloudWatchLogsFullAccess 정책 없음

**단계**: Stage 3 (IAM 역할 생성)

**증상**
IAM 콘솔에서 `CloudWatchLogsFullAccess` 정책을 검색해도 결과가 나오지 않음.

**원인**
AWS가 해당 관리형 정책을 deprecated 처리하고 콘솔 목록에서 제거함.

**해결**
`petclinic-codebuild-role`에 관리형 정책 대신 인라인 정책으로 CloudWatch Logs 권한 직접 부여:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "logs:CreateLogGroup",
        "logs:CreateLogStream",
        "logs:PutLogEvents"
      ],
      "Resource": "*"
    }
  ]
}
```

IAM → 역할 → `petclinic-codebuild-role` → **인라인 정책 추가**로 적용.

---

### 2. ECS Service 생성 시 ECR 이미지 없음 오류

**단계**: Stage 12 (ECS Service 생성) — 재정렬 전

**증상**
ECS Service 생성 시 태스크 정의를 적용하면 서비스가 PENDING 상태로 유지되거나 이미지를 pull하지 못해 태스크가 즉시 종료됨.

**원인**
가이드 순서상 ECS Service를 CodeBuild/CodePipeline보다 먼저 생성하도록 되어 있었으나, ECR에 이미지가 없는 상태에서는 서비스를 정상 기동할 수 없음.

**해결**
아래 순서로 단계를 재정렬:

```
12. CodeBuild 프로젝트 생성
13. CodePipeline 생성 (Source + Build 단계만)
14. 첫 빌드 수동 실행 → ECR에 이미지 푸시 확인
15. ECS Service 생성 (이미지가 준비된 상태)
16. CodePipeline에 Deploy 단계 추가
```

---

### 3. DB 초기화 실패 (RDS 호환 SQL 오류)

**단계**: Stage 7 (RDS) / Stage 15 (ECS Service 최초 기동)

**증상**
WAS 컨테이너 기동 시 SQL 초기화 단계에서 오류 발생, 또는 DB 테이블이 생성되지 않아 애플리케이션 에러.

**원인 1**: `initDB.sql`에 RDS 환경에서 실행 불가능한 구문 포함
```sql
CREATE DATABASE petclinic;          -- RDS에서는 이미 생성된 DB 사용
ALTER DATABASE petclinic ...;
GRANT ALL PRIVILEGES ON ...;        -- MySQL 8.0에서 문법 오류
USE petclinic;
```

**원인 2**: `application-mysql.properties`에서 SQL 초기화 설정이 주석 처리됨
```properties
# spring.sql.init.mode=always   ← 주석 상태
```

**해결**
`initDB.sql`에서 해당 4줄 제거, `CREATE TABLE IF NOT EXISTS` 구문만 유지:
```sql
-- 제거: CREATE DATABASE, ALTER DATABASE, GRANT ALL PRIVILEGES, USE petclinic
CREATE TABLE IF NOT EXISTS vets ( ... );
...
```

`application-mysql.properties` 주석 해제:
```properties
spring.sql.init.mode=always
spring.sql.init.schema-locations=classpath*:db/mysql/initDB.sql
spring.sql.init.data-locations=classpath*:db/mysql/populateDB.sql
```

---

### 4. Docker build context 경로 오류

**단계**: Stage 12 (CodeBuild 빌드 실행)

**증상**
CodeBuild 빌드 로그:
```
open Dockerfile: no such file or directory
```

**원인**
CodeBuild는 항상 **리포지토리 루트**를 작업 디렉터리로 사용함.
buildspec.yml의 `docker build .` 명령이 루트에서 실행되므로 Dockerfile을 찾지 못함.

```
# 리포지토리 구조
SmileShark-1week-assignment/        ← CodeBuild 작업 디렉터리
└── spring-petclinic-reactjs/
    ├── Dockerfile                  ← WAS Dockerfile 위치
    └── web/
        └── Dockerfile              ← WEB Dockerfile 위치
```

**해결**
`buildspec.yml`과 `web/buildspec.yml`의 `docker build` 명령에 전체 경로 지정:

```yaml
# WAS buildspec.yml
- docker build -t $ECR_REPO_URI:$IMAGE_TAG spring-petclinic-reactjs/

# WEB web/buildspec.yml
- docker build -t $ECR_REPO_URI:$IMAGE_TAG spring-petclinic-reactjs/web/
```

---

### 5. WEB CodeBuild buildspec 경로 오타

**단계**: Stage 12 (WEB CodeBuild 프로젝트 설정)

**증상**
`petclinic-web-build` 파이프라인 실행 시 빌드 실패. 오류 로그:
```
YAML_FILE_ERROR: The file pring-petclinic-reactjs/web/buildspec.yml was not found.
```

**원인**
CodeBuild 프로젝트 설정 시 buildspec 경로에 오타 입력:
- 잘못된 값: `pring-petclinic-reactjs/web/buildspec.yml` (s 누락)
- 올바른 값: `spring-petclinic-reactjs/web/buildspec.yml`

**해결**
CodeBuild 콘솔 → `petclinic-web-build` 프로젝트 → **빌드 세부 정보** → **편집** → Buildspec 섹션에서 경로 수정:

```
spring-petclinic-reactjs/web/buildspec.yml
```

---

### 6. Docker Hub 429 Too Many Requests (rate limit)

**단계**: Stage 12 (CodeBuild 빌드 실행)

**증상**
CodeBuild 빌드 로그:
```
toomanyrequests: You have reached your pull rate limit.
You may increase the limit by authenticating and upgrading: https://www.docker.com/increase-rate-limit
```

**원인**
CodeBuild 환경은 고정 IP로 Docker Hub에서 이미지를 pull함.
Docker Hub 무료 계정 기준 6시간당 100회 pull 제한이 있으며, 다수의 CodeBuild 실행이 동일 IP에서 요청되면 rate limit에 걸림.

기존 Dockerfile:
```dockerfile
# WAS
FROM eclipse-temurin:17-jdk-jammy AS builder
FROM eclipse-temurin:17-jre-jammy

# WEB
FROM nginx:1.25-alpine
```

**해결**
Docker Hub 대신 **ECR Public Gallery** 사용 (인증 불필요, rate limit 없음):

```dockerfile
# WAS Dockerfile
FROM public.ecr.aws/docker/library/eclipse-temurin:17-jdk-jammy AS builder
...
FROM public.ecr.aws/docker/library/eclipse-temurin:17-jre-jammy

# WEB Dockerfile
FROM public.ecr.aws/docker/library/nginx:1.25-alpine
```

ECR Public Gallery 경로 형식: `public.ecr.aws/docker/library/<이미지명>:<태그>`

---

### 7. CodePipeline 소스 브랜치 "Not Found"

**단계**: Stage 13 (CodePipeline Source 단계 설정)

**증상**
CodePipeline 소스 단계에서 브랜치 선택 시 드롭다운에 브랜치 목록이 나타나지 않거나 "Not Found" 표시.

**원인**
GitHub App(CodeConnections)이 해당 리포지토리에 설치되지 않은 상태.
GitHub App은 연결 생성만으로는 부족하고 **특정 리포지토리에 명시적으로 설치(Install)** 해야 함.

**해결**
CodePipeline → 소스 단계 편집 → 연결 선택 드롭다운 → **"GitHub에 연결"** 클릭 → 새 창에서:

1. **Install new app** 클릭
2. GitHub 계정/조직 선택
3. **Only select repositories** → 해당 리포지토리 체크
4. **Install & Authorize** 클릭
5. 연결 완료 후 CodePipeline으로 돌아와 브랜치 재선택

> **참고**: GitHub(버전 2) = GitHub App 방식 (권장, 만료 없음) / GitHub(버전 1) = OAuth 방식 (legacy)

---

### 8. WAS 기동 실패 — DB_URL에 jdbc 접두사 누락

**단계**: Stage 15 (ECS Service 최초 기동)

**증상**
ECS 태스크가 시작 직후 종료됨. CloudWatch 로그:
```
Caused by: java.lang.RuntimeException: Driver com.mysql.cj.jdbc.Driver claims to not accept jdbcUrl
```

**원인**
태스크 정의의 `DB_URL` 환경 변수에 JDBC 접두사 없이 RDS 엔드포인트만 입력한 경우.

```
# 잘못된 값
your-db.ap-northeast-2.rds.amazonaws.com:3306/petclinic

# 올바른 값
jdbc:mysql://your-db.ap-northeast-2.rds.amazonaws.com:3306/petclinic
```

Spring Boot의 `spring.datasource.url`은 반드시 `jdbc:mysql://`로 시작해야 함.

**해결**
ECS → **태스크 정의** → `petclinic-was` → **새 리비전 생성** → 컨테이너 편집 → 환경 변수 `DB_URL` 값 수정:
```
jdbc:mysql://<RDS 엔드포인트>:3306/petclinic
```
수정 후 ECS → `petclinic-was-svc` → **업데이트** → 새 리비전 선택 → **업데이트**.

---

### 9. WEB(nginx) 기동 실패 — Service Connect upstream 초기화 경쟁 조건

**단계**: Stage 15 (WEB ECS Service 기동)

**증상**
WAS 서비스가 정상 실행 중임에도 WEB 태스크가 시작 직후 종료됨. CloudWatch 로그:
```
[emerg] host not found in upstream "was:9966" in /etc/nginx/conf.d/default.conf:3
```
강제 재배포(`Force new deployment`)를 반복해도 동일하게 실패.

**원인**
nginx의 `upstream` 블록은 프로세스 시작 시 DNS를 **동기적으로 즉시 조회**함.
ECS 태스크 내에서 nginx와 Service Connect Envoy 사이드카가 동시에 기동되는데, nginx가 `was`를 조회하는 시점에 Envoy의 DNS 프록시가 아직 초기화되지 않아 NXDOMAIN 반환 → nginx `[emerg]` 오류로 즉시 종료.

```
# 기동 타이밍
ECS 태스크 시작
├── nginx     → 즉시 upstream DNS 조회 → Envoy 미준비 → 실패
└── Envoy     → DNS 프록시 초기화 중...
```

WAS가 이미 Service Connect에 등록되어 있어도, **WEB 태스크 내 Envoy가 준비되기 전에** nginx가 먼저 조회하면 동일하게 실패. 이 때문에 강제 재배포로는 해결이 안 됨.

**시도한 해결 (부분 해결 — 이후 추가 문제 발생)**
`upstream` 블록 제거 후 `resolver` + 변수 방식으로 DNS 조회를 **요청 시점으로 지연**:

```nginx
server {
    resolver 169.254.169.253 valid=10s ipv6=off;
    location /petclinic/ {
        set $backend http://was.petclinic-ns:9966;
        proxy_pass $backend;
    }
}
```

nginx 기동 자체는 성공하나, 이후 API 호출 시 **502 Bad Gateway** 발생.

> **근본 원인**: `resolver 169.254.169.253`(VPC DNS)에 `was` 레코드가 존재하지 않음. ECS Service Connect는 Route 53에 DNS 레코드를 생성하지 않으므로 VPC DNS로 resolve 불가. 또한 `upstream was` static 블록으로 변경하면 시작 시 resolve가 실패해 nginx 자체가 뜨지 않음.
>
> **최종 해결**: Service Connect 대신 **Internal ALB** 도입. 트러블슈팅 **#17, #18, #19** 및 **[Internal ALB 추가 설정]** 섹션 참고.

---

### 10. 푸시 후 자동 배포가 되지 않음

**단계**: Stage 22 (GitHub Secrets 설정) 이전

**증상**
코드를 `git push`해도 CodePipeline이 자동으로 실행되지 않음.

**원인**
이 아키텍처의 자동 배포 흐름:
```
git push → GitHub Actions(aws-deploy.yml) → aws codepipeline start-pipeline-execution → ECS 배포
```
CodePipeline 자체의 "파이프라인 자동 시작"은 Stage 13에서 **비활성화**했으며, 대신 GitHub Actions가 OIDC 인증으로 AWS에 접근해 파이프라인을 트리거하는 구조임.

GitHub Actions가 동작하려면 Stage 22에서 GitHub Secrets(AWS 계정 정보, OIDC 설정)가 완료되어야 함. 설정 전에는 수동 트리거("지금 릴리스")만 가능.

**해결**
Stage 22 (GitHub Secrets 설정) 및 Stage 23 (첫 배포) 진행 후 자동 배포 활성화됨.

---

### 11. CloudTrail 생성 실패 — KmsKeyNotFoundException

**단계**: Stage 17 (CloudTrail 설정)

**증상**
CloudTrail 추적 생성 시 오류:
```
KmsKeyNotFoundException: KMS key ID arn:aws:kms:ap-northeast-2:XXXX:key/aws/s3 does not exist,
or s3 bucket and key are not in the same region.
```

**원인**
CloudTrail 콘솔에서 SSE-KMS 암호화를 활성화하고 `aws/s3`(S3 관리형 KMS 키)를 선택한 경우 발생.
CloudTrail은 **S3 전용 관리형 키(`aws/s3`)를 사용할 수 없음**. CloudTrail 전용 KMS 키 또는 암호화 비활성화만 허용.

**해결**
추적 생성 또는 편집 시 **로그 파일 SSE-KMS 암호화 비활성화**. S3 버킷의 기본 SSE-S3(AES-256) 암호화로 충분함.

이미 생성된 경우: CloudTrail → `petclinic-trail` → **편집** → SSE-KMS 암호화 토글 → **비활성화** → **저장**.

---

### 12. WAF → CloudFront 연결 실패 (AWS WAF couldn't retrieve the resource)

**단계**: Stage 21 (CF WAF 생성)

**증상**
WAF 콘솔 → `petclinic-cf-waf` → 연결된 AWS 리소스 탭 → AWS 리소스 추가 클릭 시:
```
AWS WAF couldn't retrieve the resource that you requested. Retry your request.
```

**원인**
WAF 콘솔(us-east-1)에서 CloudFront 배포를 조회하는 API 호출이 실패하는 버그성 동작.

**해결**
WAF 콘솔 대신 **CloudFront 콘솔에서 반대 방향으로 연결**:

1. CloudFront → 배포 목록 → 해당 배포 클릭
2. **일반** 탭 → **편집** 클릭
3. **AWS WAF 웹 ACL** → `petclinic-cf-waf` 선택
4. **변경 사항 저장**

---

### 13. GitHub Actions 워크플로우가 트리거되지 않음

**단계**: Stage 23 (GitHub Actions 설정)

**증상**
`git push` 후 GitHub 리포지토리 → **Actions** 탭에 아무런 워크플로우 실행이 없음.

**원인**
`aws-deploy.yml` 파일이 `spring-petclinic-reactjs/.github/workflows/`에 위치해 있었음.
GitHub Actions는 **리포지토리 루트**의 `.github/workflows/`만 감지하며, 하위 디렉터리의 워크플로우는 무시함.

```
# 잘못된 위치 (무시됨)
spring-petclinic-reactjs/.github/workflows/aws-deploy.yml

# 올바른 위치 (감지됨)
.github/workflows/aws-deploy.yml
```

**해결**
리포지토리 루트에 `.github/workflows/` 디렉터리를 생성하고 파일을 복사:
```bash
mkdir -p .github/workflows
cp spring-petclinic-reactjs/.github/workflows/aws-deploy.yml .github/workflows/aws-deploy.yml
```

---

### 14. WAF 생성 콘솔 UI 변경 — 앱 카테고리 / 초기 보호 기능 선택 화면

**단계**: Stage 21 (WAF 생성)

**증상**
가이드의 WAF 생성 절차(리소스 유형 선택 → 규칙 추가)와 달리 실제 콘솔에는
**앱 카테고리**, **앱 포커스**, **초기 보호 기능 선택**(권장 규칙 / 권장 사항 / 필수) 화면이 먼저 표시됨.

**원인**
AWS WAF 콘솔이 새 UI로 개편됨. 이전 가이드는 구 UI 기준으로 작성되어 있었음.

**해결**
새 UI 기준 선택값:
- **앱 카테고리**: `기타`
- **앱 포커스**: `API와 웹 모두`
- **보호할 리소스**:
  - ALB WAF → `Amazon API Gateway REST API, Application Load Balancer...` (두 번째 옵션)
  - CF WAF → `AWS Amplify 애플리케이션, CloudFront 배포...` (첫 번째 옵션, us-east-1에서만 활성화)
- **초기 보호 기능**: `필수` (직접 구축, 월 $12 수준) 선택
  > 권장/권장 사항은 관리형 규칙 자동 포함으로 $43~59 수준, 불필요한 비용 발생

이후 규칙 추가 단계에서 커스텀 규칙(ALB) 또는 관리형 규칙(CF) 수동 추가.

---

### 15. CloudFront OAC 버킷 정책 복사 배너 미표시

**단계**: Stage 20 (CloudFront 배포 생성)

**증상**
CloudFront 배포 생성 완료 후 S3 버킷 정책을 복사하라는 노란 배너가 나타나지 않음.

**원인**
노란 배너는 배포 생성 직후 한 번만 표시됨. 이미 배포 완료 상태이거나 페이지를 벗어난 경우 재표시되지 않음.

**해결**
아래 순서로 정책 확보:
1. CloudFront → 배포 → **원본** 탭 → S3 원본 선택 → **편집** → 하단 **정책 복사** 버튼
2. 버튼이 없으면 직접 작성:
```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Service": "cloudfront.amazonaws.com" },
    "Action": "s3:GetObject",
    "Resource": "arn:aws:s3:::petclinic-frontend-<숫자>/*",
    "Condition": {
      "StringEquals": {
        "AWS:SourceArn": "arn:aws:cloudfront::<계정ID>:distribution/<배포ID>"
      }
    }
  }]
}
```
S3 → 버킷 → **권한** 탭 → **버킷 정책 편집** → 기존 내용 전체 삭제 후 위 정책 붙여넣기.

---

### 16. CodePipeline Deploy 스테이지 실패 — ECS 권한 부족

**단계**: Stage 16 (CodePipeline Deploy 스테이지 추가 후 실행)

**증상**
CodePipeline Deploy 스테이지에서 아래와 같은 오류 반복:
```
Action execution failed
Error calling startDeploy: User: arn:aws:sts::...:assumed-role/AWSCodePipelineServiceRole-.../...
is not authorized to perform: ecs:RegisterTaskDefinition on resource: *
```
최소권한(specific ARN)으로 Resource를 지정해도 계속 실패.

**원인**
CodePipeline이 자동 생성하는 서비스 역할(`AWSCodePipelineServiceRole-ap-northeast-2-petclinic-*`)에 ECS Deploy 액션에 필요한 권한이 없음.

특히 아래 이유로 특정 ARN 지정이 사실상 불가능:
- `ecs:RegisterTaskDefinition`은 AWS 자체적으로 리소스 수준 권한을 지원하지 않아 `"Resource": "*"` 필수
- `ecs:DescribeTaskDefinition`도 동일
- 태스크 정의 ARN에는 리비전 번호(`petclinic-was:1`, `:2`, `:3`...)가 포함되어 배포할 때마다 바뀌므로 ARN 고정 불가

**해결**
IAM → 역할 → `AWSCodePipelineServiceRole-ap-northeast-2-petclinic-was-pipeline` (및 web-pipeline) → **인라인 정책 추가** → **JSON**:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "ecs:RegisterTaskDefinition",
        "ecs:DescribeTaskDefinition",
        "ecs:DescribeServices",
        "ecs:UpdateService",
        "ecs:DescribeContainerInstances",
        "ecs:ListTasks",
        "ecs:DescribeTasks"
      ],
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": "iam:PassRole",
      "Resource": "*",
      "Condition": {
        "StringEqualsIfExists": {
          "iam:PassedToService": [
            "ecs-tasks.amazonaws.com",
            "ecs.amazonaws.com"
          ]
        }
      }
    }
  ]
}
```

> `iam:PassRole`은 `Resource: "*"`이지만 `StringEqualsIfExists` 조건으로 ECS 서비스로만 패스 가능하도록 제한 — 이것이 핵심 최소권한 제어 지점.
> WAS, WEB 두 파이프라인 서비스 역할 모두에 동일하게 적용.

---

### 17. WEB → WAS 502 Bad Gateway — nginx resolver와 Service Connect 비호환

**단계**: 배포 완료 후 API 호출 시

**증상**
사이트 메인페이지는 정상 로드되나 데이터가 표시되지 않음. nginx WEB 컨테이너 로그에서 아래 오류 반복:
```
[error] could not be resolved (110: Operation timed out) while sending to client
```
또는
```
[error] no resolver defined to resolve was.petclinic-ns while sending to client
```
브라우저에서 API 응답은 502 Bad Gateway.

**원인**
`nginx.conf`에 `resolver 169.254.169.253`(VPC DNS)을 명시하면 nginx가 **시스템 resolver를 완전히 우회**하고 VPC DNS에 직접 질의한다.

ECS Service Connect는 Route 53에 DNS 레코드를 생성하지 않는다:
> *"Service Connect doesn't use or create DNS hosted zones in Amazon Route 53."*
> — [AWS ECS Service Connect 공식 문서](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/service-connect-concepts.html)

따라서 VPC DNS에 `was` 또는 `was.petclinic-ns` 레코드가 존재하지 않아 resolution 실패 → 502 발생.

Service Connect의 실제 동작 방식:
- 각 ECS 태스크에 **Envoy 사이드카**가 주입됨
- Envoy가 태스크 네트워크 네임스페이스의 iptables 규칙을 통해 아웃바운드 트래픽을 인터셉트
- 애플리케이션이 `was:9966`으로 연결 시도 → Envoy가 가로채 실제 WAS 태스크로 라우팅
- *"Applications only use the proxy to connect to Service Connect endpoints. There is no additional configuration to use the proxy."*
> — [AWS ECS Service Connect 공식 문서](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/service-connect.html)

**해결**

`spring-petclinic-reactjs/web/nginx.conf` 수정:

```nginx
# 변경 전 (문제)
server {
    listen 80;
    resolver 169.254.169.253 valid=10s ipv6=off;  # VPC DNS 직접 질의 → was 레코드 없음
    location /petclinic/ {
        set $backend http://was.petclinic-ns:9966;
        proxy_pass $backend;
        ...
    }
}

# 변경 후 (정상)
upstream was {
    server was:9966;  # 시스템 resolver 사용 → Envoy가 인터셉트
}
server {
    listen 80;
    location /petclinic/ {
        proxy_pass http://was;
        ...
    }
}
```

`resolver` 지시어를 제거하면 nginx가 시스템 resolver(`/etc/resolv.conf`)를 사용하게 되고, Envoy 사이드카가 해당 연결을 인터셉트해 WAS로 정상 라우팅한다.

추가로 `spring-petclinic-reactjs/web/Dockerfile`에 startup delay 추가:

```dockerfile
# 변경 전
CMD ["nginx", "-g", "daemon off;"]

# 변경 후
CMD ["/bin/sh", "-c", "sleep 10 && exec nginx -g 'daemon off;'"]
```

nginx가 시작할 때 Envoy 사이드카가 아직 준비되지 않으면 `was` resolve가 실패할 수 있으므로 10초 대기 후 nginx를 기동.

> **주의**: WEB ECS 서비스에 Service Connect **클라이언트 구성**이 활성화되어 있어야 Envoy 사이드카가 주입된다. 콘솔 → ECS → 서비스 → 서비스 연결 탭에서 확인.

---

### 18. nginx upstream "host not found" — Service Connect와 nginx 구조적 비호환 확인

**단계**: 트러블슈팅 #17 해결 시도 후

**증상**
`resolver` 제거 + `upstream was { server was:9966; }` 방식으로 변경 후 WEB 태스크가 시작되자마자 롤백:
```
[emerg] host not found in upstream "was:9966" in /etc/nginx/conf.d/default.conf:2
nginx: [emerg] host not found in upstream "was:9966"
```
`sleep 10` startup delay를 줘도 동일하게 실패.

**원인 분석**
nginx `upstream` 블록은 **프로세스 시작 시 단 한 번 DNS resolve**를 시도한다. resolve 실패 시 nginx 자체가 기동되지 않는다.

AWS 공식 문서 확인 결과:
> *"The Cloud Map services that Service Connect creates aren't discoverable by using the DNS-based service discovery of Cloud Map."*

Service Connect가 관리하는 Cloud Map 서비스는 **DNS 타입 네임스페이스여도 DNS 쿼리로 resolve되지 않는다.** Envoy 사이드카의 iptables 인터셉트 방식으로만 동작하며, 이는 nginx의 upstream 선언 방식과 구조적으로 호환되지 않는다.

| 방식 | 결과 | 이유 |
|------|------|------|
| `resolver` + `$backend` | 실패 | VPC DNS에 `was` 레코드 없음 |
| `upstream was` (static) | 실패 | 시작 시 DNS resolve 불가, nginx 기동 거부 |

**해결: Internal ALB 도입**

WEB → WAS 구간에 Internal ALB를 추가하여 nginx가 ALB DNS 이름(VPC DNS로 정상 resolve 가능)을 통해 WAS에 접근하도록 아키텍처를 변경한다.

변경 후 아키텍처:
```
ECS WEB (nginx)
    │ http://<internal-alb-dns>
    ▼
Internal ALB (petclinic-was-internal-alb)
    │ :9966
    ▼
ECS WAS (Spring Boot)
```

설정 절차는 아래 **[Internal ALB 추가 설정]** 섹션 참고.

---

### 19. nginx.conf ALB DNS 하드코딩 — 인프라 변경 시 재배포 필요 문제

**단계**: Internal ALB 도입 후 nginx.conf 작성 시

**증상**
nginx.conf에 ALB DNS 이름을 직접 하드코딩:
```nginx
set $backend http://petclinic-was-internal-alb-xxx.ap-northeast-2.elb.amazonaws.com;
```
ALB가 재생성(인프라 교체, 재구축)될 경우 DNS 이름이 바뀌므로 코드 수정 + 재배포가 필요해짐.

**원인**
ALB DNS 이름은 ALB 리소스에 종속된 값으로, 인프라와 코드가 강하게 결합되는 안티패턴.

**해결**
nginx.conf에 placeholder를 사용하고, Dockerfile에서 컨테이너 시작 시 환경변수로 치환:

`nginx.conf`:
```nginx
set $backend http://INTERNAL_ALB_DNS_PLACEHOLDER;
```

`Dockerfile`:
```dockerfile
CMD ["/bin/sh", "-c", "sed -i 's|INTERNAL_ALB_DNS_PLACEHOLDER|'\"$WAS_ALB_DNS\"'|g' /etc/nginx/conf.d/default.conf && exec nginx -g 'daemon off;'"]
```

ECS 태스크 정의 환경변수에 `WAS_ALB_DNS` = ALB DNS 이름 설정.

ALB가 재생성되면 **ECS 태스크 정의의 환경변수 값만 수정**하면 되며, 코드 변경 및 파이프라인 실행 불필요.

---

## Internal ALB 추가 설정

WEB → WAS 트래픽을 Internal ALB로 라우팅하기 위한 추가 구성.

### Step 1. Security Group 생성 — petclinic-was-alb-sg

> EC2 → 보안 그룹 → **보안 그룹 생성**

| 항목 | 값 |
|------|-----|
| 이름 | `petclinic-was-alb-sg` |
| VPC | `petclinic-vpc` |

**인바운드 규칙:**

| 유형 | 프로토콜 | 포트 | 소스 |
|------|----------|------|------|
| HTTP | TCP | 80 | WEB 컨테이너 보안 그룹 (`petclinic-web-sg` 또는 Private 서브넷 CIDR) |

**아웃바운드 규칙:** 모든 트래픽 허용 (기본값 유지)

---

### Step 2. WAS Security Group 인바운드 규칙 추가

> EC2 → 보안 그룹 → `petclinic-was-sg` → **인바운드 규칙 편집**

| 유형 | 프로토콜 | 포트 | 소스 |
|------|----------|------|------|
| 사용자 지정 TCP | TCP | 9966 | `petclinic-was-alb-sg` |

---

### Step 3. Target Group 생성

> EC2 → 대상 그룹 → **대상 그룹 생성**

| 항목 | 값 |
|------|-----|
| 대상 유형 | **IP 주소** (awsvpc 네트워크 모드) |
| 이름 | `petclinic-was-tg` |
| 프로토콜 | HTTP |
| 포트 | `9966` |
| VPC | `petclinic-vpc` |

**상태 검사 설정:**

| 항목 | 값 |
|------|-----|
| 프로토콜 | HTTP |
| 경로 | `/petclinic/actuator/health` |
| 정상 임계값 | 2 |
| 비정상 임계값 | 3 |
| 제한 시간 | 5초 |
| 간격 | 30초 |
| 성공 코드 | `200` |

> **경로 근거**: `server.servlet.context-path=/petclinic/` ([application.properties](../spring-petclinic-reactjs/src/main/resources/application.properties#L24)) + Spring Boot Actuator 기본 경로 `/actuator` = `/petclinic/actuator/health`. `spring-boot-starter-actuator` 의존성 포함([pom.xml](../spring-petclinic-reactjs/pom.xml)), 별도 management port 설정 없으므로 9966 포트에서 응답. 정상 시 HTTP 200, DB 연결 불가 시 HTTP 503 반환.

대상 등록은 하지 않고 **생성** (ECS 서비스가 자동 등록).

---

### Step 4. Internal ALB 생성

> EC2 → 로드 밸런서 → **로드 밸런서 생성** → Application Load Balancer

| 항목 | 값 |
|------|-----|
| 이름 | `petclinic-was-internal-alb` |
| 체계 | **내부 (Internal)** |
| IP 주소 유형 | IPv4 |
| VPC | `petclinic-vpc` |
| 서브넷 | Private 서브넷 2개: `10.0.11.0/24` (2a), `10.0.12.0/24` (2c) |
| 보안 그룹 | `petclinic-was-alb-sg` |

**리스너:**

| 프로토콜 | 포트 | 기본 작업 |
|----------|------|-----------|
| HTTP | 80 | `petclinic-was-tg`로 전달 |

생성 완료 후 **DNS 이름** 복사 (예: `petclinic-was-internal-alb-xxxxxxxxx.ap-northeast-2.elb.amazonaws.com`)

---

### Step 5. WAS ECS 서비스에 Target Group 연결

> ECS → 클러스터 → `petclinic-cluster` → `petclinic-was-svc` → **업데이트**

- **로드 밸런싱** 섹션 → **로드 밸런서 추가**
  - 로드 밸런서: `petclinic-was-internal-alb`
  - 컨테이너: `petclinic-was` : `9966`
  - 대상 그룹: `petclinic-was-tg`
- **업데이트** → WAS 재배포 대기

WAS 태스크가 **Running** + 대상 그룹 상태 **healthy** 확인 후 진행.

---

### Step 6. 코드 수정 — nginx.conf + Dockerfile

ALB DNS를 코드에 하드코딩하지 않고 환경변수로 주입하는 방식 적용. (트러블슈팅 #19 참고)

`spring-petclinic-reactjs/web/nginx.conf`:
```nginx
server {
    listen 80;

    resolver 169.254.169.253 valid=10s ipv6=off;

    location = /health {
        return 200 'OK';
        add_header Content-Type text/plain;
    }

    location /petclinic/ {
        set $backend http://INTERNAL_ALB_DNS_PLACEHOLDER;
        proxy_pass $backend;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

`spring-petclinic-reactjs/web/Dockerfile`:
```dockerfile
FROM public.ecr.aws/docker/library/nginx:1.25-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["/bin/sh", "-c", "sed -i 's|INTERNAL_ALB_DNS_PLACEHOLDER|'\"$WAS_ALB_DNS\"'|g' /etc/nginx/conf.d/default.conf && exec nginx -g 'daemon off;'"]
```

수정 완료 후 git push → WEB 파이프라인 자동 실행 (이미지 빌드 및 ECR 푸시).

---

### Step 7. WEB ECS 태스크 정의에 환경변수 추가

> ECS → 태스크 정의 → `petclinic-web` → **새 개정 생성**

컨테이너 `petclinic-web` → **환경 변수** 섹션에 추가:

| 키 | 값 |
|----|-----|
| `WAS_ALB_DNS` | Step 4에서 복사한 ALB DNS 이름 |

새 개정 저장.

---

### Step 8. WEB ECS 서비스 배포

> ECS → `petclinic-web-svc` → **업데이트**

- 태스크 정의: `petclinic-web` 최신 개정 선택
- **업데이트** → 배포 완료 대기

WEB 태스크가 Running 상태가 되면 사이트 접속 및 API 정상 동작 확인.

---

### Step 9. WEB ECS 서비스 Service Connect 비활성화 (선택)

Internal ALB를 통해 라우팅하므로 WEB 서비스의 Service Connect 클라이언트 구성이 불필요.

> ECS → `petclinic-web-svc` → **업데이트** → **서비스 연결** → **비활성화**

Envoy 사이드카가 제거되어 WEB 태스크 리소스 사용량이 감소.
